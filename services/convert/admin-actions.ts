// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";

import { requireFundRole } from "@/services/auth/dal";
import {
  errorFor,
  proposed,
  requireProposerStepUp,
  revalidateSafe,
  type T,
} from "@/services/safe/action-helpers";
import type { ProposeActionResult } from "@/services/safe/action-types";

import type { CancelConversionResult, PrepareQuoteResult, QuoteActionResult, StartActionResult } from "./action-types";
import {
  cancelConversion,
  completeStart,
  continueConversion,
  prepareQuote,
  quoteConversion,
  startConversion,
} from "./engine";
import {
  CompleteStartSchema,
  ConversionIdSchema,
  QuoteConversionSchema,
  StartConversionSchema,
  type ConversionIdInput,
  type CompleteStartInput,
  type QuoteConversionInput,
  type StartConversionInput,
} from "./schemas";
import { isConvertError } from "./types";

// ADMIN-gated wrappers over services/convert/engine.ts. The fund always
// comes from the host (requireFundRole); the Safe and conversion ids in the
// input are re-scoped to it by the engine. Starting and continuing create a
// Safe proposal, so they are gated like a transfer: role, input, step-up
// (unless the proposer signs with a passkey — the ceremony is the step-up).

// ConvertError → `fund.safes.conversion.errors.<code>`; a SafeError from the
// proposal itself → the Safe strings.
function convertErrorFor(t: T, e: unknown, context: string): string {
  if (isConvertError(e)) {
    // User-side refusals are expected and not logged; a throttle is logged
    // with the orderbook's words (they name the quota that was hit).
    if (e.code !== "quote_moved" && e.code !== "no_pair" && e.code !== "amount") {
      console.warn(`[convert] ${context}:`, e.code, e.message);
    }
    return t(`fund.safes.conversion.errors.${e.code}` as never);
  }
  return errorFor(t, e, context);
}

// The quote in two halves so the admin's browser can make the outside call
// (browser-quote.ts): prepare gives the request, quote takes the answer. A
// quote without `relayed` is the server calling out itself.
export async function prepareQuoteAction(input: QuoteConversionInput): Promise<PrepareQuoteResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");
  const parsed = QuoteConversionSchema.safeParse(input);
  if (!parsed.success) return { error: t(parsed.error.issues[0].message as never) };
  try {
    const request = await prepareQuote({ fund, ...parsed.data });
    return { ok: true, request };
  } catch (e) {
    return { error: convertErrorFor(t, e, "prepare-quote") };
  }
}

export async function quoteConversionAction(input: QuoteConversionInput): Promise<QuoteActionResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");
  const parsed = QuoteConversionSchema.safeParse(input);
  if (!parsed.success) return { error: t(parsed.error.issues[0].message as never) };
  try {
    const quote = await quoteConversion({ fund, ...parsed.data });
    return { ok: true, quote };
  } catch (e) {
    return { error: convertErrorFor(t, e, "quote") };
  }
}

// Starting is gated like a proposal from its first half: the order goes out
// under the fund's name, and the proposal follows seconds later on the same
// step-up proof.
export async function startConversionAction(input: StartConversionInput): Promise<StartActionResult> {
  const t = await getTranslations();
  const { fund, user } = await requireFundRole("ADMIN");
  const parsed = StartConversionSchema.safeParse(input);
  if (!parsed.success) return { error: t(parsed.error.issues[0].message as never) };
  const { safeId, ...rest } = parsed.data;

  const stepUp = await requireProposerStepUp(t, { fundId: fund.id, safeId, userId: user.id });
  if (stepUp) return stepUp;

  try {
    const res = await startConversion({ fund, safeId, userId: user.id, input: rest });
    if (res.kind === "relay") return { ok: true, relay: { ticket: res.ticket, request: res.request } };
    revalidateSafe(safeId);
    return proposed(res.started.proposal);
  } catch (e) {
    revalidateSafe(safeId);
    return { error: convertErrorFor(t, e, "start") };
  }
}

export async function completeConversionStartAction(input: CompleteStartInput): Promise<ProposeActionResult> {
  const t = await getTranslations();
  const { fund, user } = await requireFundRole("ADMIN");
  const parsed = CompleteStartSchema.safeParse(input);
  if (!parsed.success) return { error: t(parsed.error.issues[0].message as never) };
  const { safeId, ticket, relayed } = parsed.data;

  const stepUp = await requireProposerStepUp(t, { fundId: fund.id, safeId, userId: user.id });
  if (stepUp) return stepUp;

  try {
    const res = await completeStart({ fund, safeId, userId: user.id, ticket, relayed: relayed ?? null });
    revalidateSafe(safeId);
    return proposed(res.proposal);
  } catch (e) {
    revalidateSafe(safeId);
    return { error: convertErrorFor(t, e, "complete-start") };
  }
}

export async function continueConversionAction(input: ConversionIdInput): Promise<ProposeActionResult> {
  const t = await getTranslations();
  const { fund, user } = await requireFundRole("ADMIN");
  const parsed = ConversionIdSchema.safeParse(input);
  if (!parsed.success) return { error: t("fund.safes.errors.unknown" as never) };
  const { safeId, conversionId } = parsed.data;

  const stepUp = await requireProposerStepUp(t, { fundId: fund.id, safeId, userId: user.id });
  if (stepUp) return stepUp;

  try {
    const res = await continueConversion({ fund, safeId, userId: user.id, conversionId });
    revalidateSafe(safeId);
    return proposed(res);
  } catch (e) {
    revalidateSafe(safeId);
    return { error: convertErrorFor(t, e, "continue") };
  }
}

export async function cancelConversionAction(input: ConversionIdInput): Promise<CancelConversionResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");
  const parsed = ConversionIdSchema.safeParse(input);
  if (!parsed.success) return { error: t("fund.safes.errors.unknown" as never) };
  const { safeId, conversionId } = parsed.data;
  try {
    await cancelConversion({ fund, safeId, conversionId });
    revalidateSafe(safeId);
    return { ok: true };
  } catch (e) {
    return { error: convertErrorFor(t, e, "cancel") };
  }
}
