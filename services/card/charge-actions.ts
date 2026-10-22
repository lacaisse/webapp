// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireFundRole } from "@/services/auth/dal";
import { CitizenPayApiError } from "@/services/citizenpay/api";
import { getCitizenPayClient } from "@/services/citizenpay/client";
import type { OpenPlaceOrder } from "@/services/citizenpay/types";
import { prisma } from "@/services/db/prisma";

import {
  CHARGE_DESCRIPTION_MAX,
  CHARGE_IDEMPOTENCY_KEY_RE,
  CHARGE_PIN_HASH_RE,
  chargeErrorKey,
} from "./charge-errors";

// =============================================================================
// Admin charge-on-card towards a merchant
// =============================================================================
// The fund admin collects a sale a merchant's pay-pos failed to take from the
// member's card: either an uncollected order the terminal opened (listed by
// `listOpenMerchantOrdersAction`) or, when the terminal never recorded one, an
// amount + description — Citizen Pay then creates the order on the merchant's
// place as the terminal would have, so the sale shows in the merchant's sales
// and payouts. Both go through CP's treasury-key charge-card routes
// (services/citizenpay/client-interface.ts); CP claims the order before any
// money moves, so a double submit can never pay twice.
//
// The flow follows the pay-pos: the charge is sent without a PIN; when CP
// answers 428 the dialog asks the cardholder for it, hashes it in the browser
// (services/card/pin-hash — the raw PIN never reaches this server) and resends
// the same request with the digest. A manual charge carries an idempotency
// key minted when the dialog opened and kept across its retries, so a retry
// after an outcome the browser never learned (a timeout) is answered with the
// order the first attempt made rather than a second one.
//
// Money off a card is ADMIN-only, like top-up / withdraw.

export type ChargeableMerchant = {
  id: string;
  name: string;
  placeId: string;
};

export type ChargeCardOutcome =
  // The card paid the merchant; the order is settled (or, settled false,
  // the funds moved but CP could not finish its bookkeeping — alerted on
  // their side, never charged again).
  | {
      ok: true;
      orderId: number;
      txHash: string;
      settled: boolean;
      // A retry of an attempt that had already paid: this is that charge.
      existing: boolean;
    }
  // The card has a PIN: ask for it and resend with `pinHash`.
  | { ok: false; pinRequired: true }
  // Refused. `orderId` is set when an order exists for this attempt — the
  // manual route created one and the card then refused (orderStatus
  // "pending": charge THAT order next, never create another) or CP is
  // confirming an outcome it does not know ("confirming": stop, never retry).
  | {
      ok: false;
      pinRequired: false;
      error: string;
      // The i18n key behind `error` when the refusal is one we name
      // (services/card/charge-errors), null when `error` is CP's own
      // sentence. The dialog branches on this, never on the text.
      errorKey: string | null;
      orderId: number | null;
      orderStatus: string | null;
    };

const SERIAL_RE = /^[0-9A-Za-z]{4,64}$/;

const ChargeCardSchema = z.object({
  cardId: z.string().min(1),
  merchantId: z.string().min(1),
  // Exactly one of: an uncollected order to pay, or an amount to create one.
  orderId: z.number().int().positive().nullable(),
  amountCents: z.number().int().positive().nullable(),
  description: z.string().max(CHARGE_DESCRIPTION_MAX).nullable(),
  pinHash: z.string().regex(CHARGE_PIN_HASH_RE).nullable(),
  idempotencyKey: z.string().regex(CHARGE_IDEMPOTENCY_KEY_RE),
});

export type ChargeCardInput = z.infer<typeof ChargeCardSchema>;

/**
 * The merchant's uncollected terminal sales — what the dialog offers to charge
 * before falling back to a manual amount. Empty when the merchant has none
 * (or is not connected to Citizen Pay).
 */
export async function listOpenMerchantOrdersAction(input: {
  merchantId: string;
}): Promise<{ orders: OpenPlaceOrder[] } | { error: string }> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");
  const merchant = await prisma.merchant.findFirst({
    where: { id: input.merchantId, fundId: fund.id },
    select: { citizenPayPlaceId: true },
  });
  if (!merchant?.citizenPayPlaceId) {
    return { error: t("cards.admin.charge.errors.merchantNotFound" as never) };
  }
  try {
    const orders = await getCitizenPayClient(fund).listOpenPlaceOrders(
      merchant.citizenPayPlaceId,
    );
    return { orders };
  } catch (e) {
    console.error("[card] listOpenMerchantOrders failed", input.merchantId, e);
    return { error: t("cards.admin.charge.errors.ordersFailed" as never) };
  }
}

export async function chargeCardAction(
  input: ChargeCardInput,
): Promise<ChargeCardOutcome> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const refuse = (
    error: string,
    extra: {
      errorKey?: string | null;
      orderId?: number | null;
      orderStatus?: string | null;
    } = {},
  ): ChargeCardOutcome => ({
    ok: false,
    pinRequired: false,
    error,
    errorKey: extra.errorKey ?? null,
    orderId: extra.orderId ?? null,
    orderStatus: extra.orderStatus ?? null,
  });
  // A refusal of ours, by key.
  const refuseKey = (
    key: string,
    extra: { orderId?: number | null; orderStatus?: string | null } = {},
  ): ChargeCardOutcome => refuse(t(key as never), { ...extra, errorKey: key });

  const parsed = ChargeCardSchema.safeParse(input);
  if (!parsed.success) {
    return refuseKey("cards.admin.charge.errors.invalidInput");
  }
  const data = parsed.data;
  if ((data.orderId === null) === (data.amountCents === null)) {
    return refuseKey("cards.admin.charge.errors.invalidInput");
  }

  const card = await prisma.card.findFirst({
    where: { id: data.cardId, fundId: fund.id },
    select: { id: true, serialNumber: true, status: true, memberId: true },
  });
  if (!card) return refuseKey("cards.admin.errors.notFound");
  if (card.status === "BLOCKED") {
    return refuseKey("cards.admin.charge.errors.cardBlocked");
  }
  // The serial goes to CP exactly as stored — it is the salt of the PIN
  // digest the dialog computed from the same string.
  const serial = card.serialNumber;
  if (!SERIAL_RE.test(serial)) {
    return refuseKey("cards.admin.charge.errors.cardNotFound");
  }

  const merchant = await prisma.merchant.findFirst({
    where: { id: data.merchantId, fundId: fund.id, status: "ACTIVE" },
    select: { id: true, citizenPayPlaceId: true },
  });
  if (!merchant?.citizenPayPlaceId) {
    return refuseKey("cards.admin.charge.errors.merchantNotFound");
  }

  const cp = getCitizenPayClient(fund);
  // An order is charged only when it sits on the chosen merchant's place:
  // the api scopes an order by token, not by place, so without this a stale
  // or tampered orderId would pay another merchant while the dialog names
  // this one. The open list is what the dialog offered (plus an order the
  // manual route created, still pending there).
  if (data.orderId !== null) {
    let open: OpenPlaceOrder[];
    try {
      open = await cp.listOpenPlaceOrders(merchant.citizenPayPlaceId);
    } catch (e) {
      console.error("[card] chargeCard: open orders of", merchant.id, e);
      return refuseKey("cards.admin.charge.errors.ordersFailed");
    }
    if (!open.some((o) => o.id === data.orderId)) {
      return refuseKey("cards.admin.charge.errors.orderNotFound");
    }
  }
  try {
    const result =
      data.orderId !== null
        ? await cp.chargeCardForOrder(data.orderId, {
            serialNumber: serial,
            pinHash: data.pinHash,
          })
        : await cp.chargeCardOnPlace(merchant.citizenPayPlaceId, {
            serialNumber: serial,
            pinHash: data.pinHash,
            amountCents: data.amountCents ?? 0,
            description: data.description?.trim() || null,
            idempotencyKey: data.idempotencyKey,
          });
    revalidatePath("/cards");
    revalidatePath(`/cards/${card.id}`);
    if (card.memberId) revalidatePath(`/members/${card.memberId}`);
    revalidatePath("/merchants");
    return {
      ok: true,
      orderId: result.orderId,
      txHash: result.txHash,
      settled: result.settled,
      existing: result.existing,
    };
  } catch (e) {
    if (e instanceof CitizenPayApiError) {
      if (e.status === 428) return { ok: false, pinRequired: true };
      const body = objectOrNull(e.body);
      const orderId = body ? numberOrNull(body.orderId) : null;
      const orderStatus = body ? stringOrNull(body.orderStatus) : null;
      const key = chargeErrorKey(e.message);
      if (!key) {
        // Shown as CP said it; logged by status only (no serial, no PIN).
        console.error(
          `[card] chargeCard refused: status ${e.status}, order ${orderId ?? "-"}`,
        );
      }
      return key
        ? refuseKey(key, { orderId, orderStatus })
        : refuse(e.message, { orderId, orderStatus });
    }
    // The call itself failed (network, timeout) before an answer came back.
    // Trying again is safe: a manual retry carries the same idempotency
    // key, so CP answers with the order the first attempt made (and its
    // charge) rather than a second one; a retry on an order the first
    // attempt paid is refused by CP's claim.
    console.error("[card] chargeCard failed", card.id, merchant.id, e);
    return refuseKey("cards.admin.charge.errors.unknown");
  }
}

function objectOrNull(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function numberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function stringOrNull(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}
