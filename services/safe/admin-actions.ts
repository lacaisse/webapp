// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { refresh, revalidatePath } from "next/cache";

import { requireFundRole } from "@/services/auth/dal";

import type {
  CreateSafeActionResult,
  ProposeActionResult,
  SafeActionResult,
  SignActionResult,
} from "./action-types";
import {
  archiveSafe,
  createSafe,
  proposeOwnerChange,
  proposeRejection,
  proposeTokenTransfer,
  renameSafe,
  retryExecution,
  retrySafeDeployment,
  signTransaction,
} from "./proposals";
import {
  CreateSafeSchema,
  ProposeOwnerChangeSchema,
  ProposeTransferSchema,
  RenameSafeSchema,
  SafeIdSchema,
  SafeTxIdSchema,
  type CreateSafeInput,
  type ProposeOwnerChangeInput,
  type ProposeTransferInput,
} from "./schemas";
import { syncSafe } from "./sync";
import { isSafeError } from "./types";

// Thin, ADMIN-gated wrappers over the fund-parameterised core in
// proposals.ts / sync.ts. The fund always comes from the host
// (requireFundRole), never from input; ids in input are re-scoped to it by
// the core. Result types live in ./action-types ("use server" files may only
// export async functions).

type T = Awaited<ReturnType<typeof getTranslations>>;

// SafeError code → `fund.safes.errors.<code>`; anything else is logged and
// reported as `unknown`.
function errorFor(t: T, e: unknown, context: string): string {
  if (isSafeError(e)) {
    if (e.code !== "not_owner" && e.code !== "already_signed" && e.code !== "threshold") {
      console.warn(`[safe] ${context}:`, e.code, e.message);
    }
    return t(`fund.safes.errors.${e.code}` as never);
  }
  console.error(`[safe] ${context} failed`, e);
  return t("fund.safes.errors.unknown" as never);
}

function revalidateSafe(safeId?: string) {
  revalidatePath("/safes");
  if (safeId) revalidatePath(`/safes/${safeId}`);
  refresh();
}

export async function createSafeAction(input: CreateSafeInput): Promise<CreateSafeActionResult> {
  const t = await getTranslations();
  const { fund, user } = await requireFundRole("ADMIN");

  const parsed = CreateSafeSchema.safeParse(input);
  if (!parsed.success) return { error: t(parsed.error.issues[0].message as never) };

  try {
    const { safeId } = await createSafe({ fund, userId: user.id, input: parsed.data });
    revalidateSafe(safeId);
    return { ok: true, safeId };
  } catch (e) {
    // A failed deployment leaves a FAILED row (retryable) — show it.
    revalidateSafe();
    return { error: errorFor(t, e, "create") };
  }
}

export async function retrySafeDeploymentAction(input: {
  safeId: string;
}): Promise<SafeActionResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const parsed = SafeIdSchema.safeParse(input);
  if (!parsed.success) return { error: t(parsed.error.issues[0].message as never) };

  try {
    await retrySafeDeployment({ fundId: fund.id, safeId: parsed.data.safeId });
    revalidateSafe(parsed.data.safeId);
    return { ok: true };
  } catch (e) {
    revalidateSafe(parsed.data.safeId);
    return { error: errorFor(t, e, "retry deployment") };
  }
}

export async function renameSafeAction(input: {
  safeId: string;
  name: string;
}): Promise<SafeActionResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const parsed = RenameSafeSchema.safeParse(input);
  if (!parsed.success) return { error: t(parsed.error.issues[0].message as never) };

  try {
    await renameSafe({ fundId: fund.id, safeId: parsed.data.safeId, name: parsed.data.name });
    revalidateSafe(parsed.data.safeId);
    return { ok: true };
  } catch (e) {
    return { error: errorFor(t, e, "rename") };
  }
}

export async function archiveSafeAction(input: { safeId: string }): Promise<SafeActionResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const parsed = SafeIdSchema.safeParse(input);
  if (!parsed.success) return { error: t(parsed.error.issues[0].message as never) };

  try {
    await archiveSafe({ fundId: fund.id, safeId: parsed.data.safeId });
    // No refresh(): the client navigates away from the archived detail page
    // (refreshing it would 404); the list is revalidated.
    revalidatePath("/safes");
    revalidatePath(`/safes/${parsed.data.safeId}`);
    return { ok: true };
  } catch (e) {
    return { error: errorFor(t, e, "archive") };
  }
}

export async function proposeTransferAction(
  input: ProposeTransferInput,
): Promise<ProposeActionResult> {
  const t = await getTranslations();
  const { fund, user } = await requireFundRole("ADMIN");

  const parsed = ProposeTransferSchema.safeParse(input);
  if (!parsed.success) return { error: t(parsed.error.issues[0].message as never) };
  // TokenOperation.amount is Decimal(12,2).
  if ((parsed.data.amount.split(".")[1] ?? "").length > 2) {
    return { error: t("fund.safes.errors.amountInvalid" as never) };
  }

  try {
    const res = await proposeTokenTransfer({
      fund,
      safeId: parsed.data.safeId,
      userId: user.id,
      input: parsed.data,
    });
    revalidateSafe(parsed.data.safeId);
    return {
      ok: true,
      transactionId: res.transactionId,
      executed: res.executed,
      txHash: res.txHash,
    };
  } catch (e) {
    revalidateSafe(parsed.data.safeId);
    return { error: errorFor(t, e, "propose transfer") };
  }
}

export async function proposeOwnerChangeAction(
  input: ProposeOwnerChangeInput,
): Promise<ProposeActionResult> {
  const t = await getTranslations();
  const { fund, user } = await requireFundRole("ADMIN");

  const parsed = ProposeOwnerChangeSchema.safeParse(input);
  if (!parsed.success) return { error: t(parsed.error.issues[0].message as never) };

  try {
    const res = await proposeOwnerChange({
      fund,
      safeId: parsed.data.safeId,
      userId: user.id,
      input: parsed.data,
    });
    revalidateSafe(parsed.data.safeId);
    return {
      ok: true,
      transactionId: res.transactionId,
      executed: res.executed,
      txHash: res.txHash,
    };
  } catch (e) {
    revalidateSafe(parsed.data.safeId);
    return { error: errorFor(t, e, "propose owner change") };
  }
}

export async function proposeRejectionAction(input: {
  safeId: string;
  transactionId: string;
}): Promise<ProposeActionResult> {
  const t = await getTranslations();
  const { fund, user } = await requireFundRole("ADMIN");

  const parsed = SafeTxIdSchema.safeParse(input);
  if (!parsed.success) return { error: t(parsed.error.issues[0].message as never) };

  try {
    const res = await proposeRejection({
      fund,
      safeId: parsed.data.safeId,
      userId: user.id,
      transactionId: parsed.data.transactionId,
    });
    revalidateSafe(parsed.data.safeId);
    return {
      ok: true,
      transactionId: res.transactionId,
      executed: res.executed,
      txHash: res.txHash,
    };
  } catch (e) {
    revalidateSafe(parsed.data.safeId);
    return { error: errorFor(t, e, "propose rejection") };
  }
}

export async function signTransactionAction(input: {
  safeId: string;
  transactionId: string;
}): Promise<SignActionResult> {
  const t = await getTranslations();
  const { fund, user } = await requireFundRole("ADMIN");

  const parsed = SafeTxIdSchema.safeParse(input);
  if (!parsed.success) return { error: t(parsed.error.issues[0].message as never) };

  try {
    const res = await signTransaction({
      fundId: fund.id,
      transactionId: parsed.data.transactionId,
      userId: user.id,
    });
    revalidateSafe(parsed.data.safeId);
    return { ok: true, executed: res.executed, txHash: res.txHash };
  } catch (e) {
    revalidateSafe(parsed.data.safeId);
    return { error: errorFor(t, e, "sign") };
  }
}

export async function retryExecutionAction(input: {
  safeId: string;
  transactionId: string;
}): Promise<SignActionResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const parsed = SafeTxIdSchema.safeParse(input);
  if (!parsed.success) return { error: t(parsed.error.issues[0].message as never) };

  try {
    const res = await retryExecution({
      fundId: fund.id,
      transactionId: parsed.data.transactionId,
    });
    revalidateSafe(parsed.data.safeId);
    return { ok: true, executed: res.executed, txHash: res.txHash };
  } catch (e) {
    revalidateSafe(parsed.data.safeId);
    return { error: errorFor(t, e, "retry execution") };
  }
}

export async function syncSafeAction(input: { safeId: string }): Promise<SafeActionResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const parsed = SafeIdSchema.safeParse(input);
  if (!parsed.success) return { error: t(parsed.error.issues[0].message as never) };

  try {
    await syncSafe({ fundId: fund.id, safeId: parsed.data.safeId, force: true });
    revalidateSafe(parsed.data.safeId);
    return { ok: true };
  } catch (e) {
    return { error: errorFor(t, e, "sync") };
  }
}
