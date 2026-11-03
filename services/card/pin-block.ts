// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { getCitizenPayClient } from "@/services/citizenpay/client";
import type { CitizenPayCardDetail } from "@/services/citizenpay/types";
import type {
  CardBlockedReason,
  CardEventSource,
  CardStatus,
} from "@/services/db/generated/enums";
import { prisma } from "@/services/db/prisma";

import {
  sendCardPinBlockedEmails,
  type PinBlockEmailCard,
  type PinBlockEmailFund,
} from "./pin-block-emails";
import {
  planCardStateSync,
  type CardStateTransition,
  type RemoteCardState,
} from "./pin-block-rules";

// A card's PIN block, as La Caisse sees it (D12). Citizen Pay blocks a card
// after three wrong PIN entries (`pin_blocked_at`) and tells the fund through
// the treasury events webhook (app/api/citizenpay/events); the card sync's
// run step and a refused status push catch what the webhook missed. Every
// path ends here: the api's card is re-read, `planCardStateSync` (the pure
// rule) decides, and the local row, a CardEvent audit line and — for a new
// block — the notifications are written. Nothing in this module trusts a
// webhook payload, only the api's own card read.

export { isPinBlocked } from "./pin-block-rules";

export type LocalCard = {
  id: string;
  status: CardStatus;
  blockedReason: CardBlockedReason | null;
  blockedAt: Date | null;
};

// What applying the api's state needs to know about the card: the status
// columns, and whom to notify (services/card/pin-block-emails.ts).
export type ReconcilableCard = LocalCard & PinBlockEmailCard;

export const RECONCILABLE_CARD_SELECT = {
  id: true,
  serialNumber: true,
  status: true,
  blockedReason: true,
  blockedAt: true,
  number: true,
  holderName: true,
  memberId: true,
  member: { select: { firstName: true, lastName: true, email: true } },
} as const;

export type CardEventContext = {
  actorUserId?: string | null;
  citizenPayEventId?: string | null;
  placeId?: string | null;
  placeName?: string | null;
  terminalId?: string | null;
};

export type AppliedCardState = {
  transition: CardStateTransition;
  // The notifications a freshly imported PIN block sent; null otherwise.
  notified: { staff: number; holder: boolean } | null;
};

/**
 * Apply what the api says about a card to the local row. A PIN block is
 * imported (BLOCKED, `blockedReason` PIN, `blockedAt` = the api's time) and
 * the fund's staff and the holder notified; a lifted one is pulled back to
 * the api's status; a fund block is left alone (local-authoritative — the
 * sync pushes it) unless the api refused that push (`apiRefused`). Writes a
 * CardEvent for every change so the card page can say what happened and
 * when. The notifications are keyed on the api's event id when there is
 * one, else on the block's time, so neither a redelivery nor a sync after
 * the webhook mails anyone twice.
 */
export async function applyRemoteCardState(args: {
  fund: PinBlockEmailFund;
  card: ReconcilableCard;
  remote: RemoteCardState;
  source: CardEventSource;
  context?: CardEventContext;
  now?: Date;
  apiRefused?: boolean;
}): Promise<AppliedCardState> {
  const now = args.now ?? new Date();
  const transition = planCardStateSync(args.card, args.remote, now, {
    apiRefused: args.apiRefused,
  });
  if (transition.kind !== "pin_block" && transition.kind !== "pin_release") {
    return { transition, notified: null };
  }

  await prisma.card.update({
    where: { id: args.card.id },
    data: transition.data,
  });
  const ctx = args.context ?? {};
  try {
    await prisma.cardEvent.create({
      data: {
        fundId: args.fund.id,
        cardId: args.card.id,
        kind: transition.kind === "pin_block" ? "PIN_BLOCKED" : "PIN_UNBLOCKED",
        source: args.source,
        actorUserId: ctx.actorUserId ?? null,
        citizenPayEventId: ctx.citizenPayEventId ?? null,
        placeId: ctx.placeId ?? null,
        placeName: ctx.placeName ?? null,
        terminalId: ctx.terminalId ?? null,
        at: transition.kind === "pin_block" ? transition.data.blockedAt : now,
      },
    });
  } catch (e) {
    // The state is right; only the audit line is missing. Logged, never
    // thrown — the caller's own write already landed.
    console.error("[card.pin-block] CardEvent write failed", args.card.id, e);
  }

  if (transition.kind !== "pin_block") return { transition, notified: null };
  const blockedAt = transition.data.blockedAt;
  const notified = await sendCardPinBlockedEmails({
    fund: args.fund,
    card: args.card,
    eventId: ctx.citizenPayEventId ?? `pin-blocked-at:${blockedAt.toISOString()}`,
    placeName: ctx.placeName ?? null,
    blockedAt,
  });
  return { transition, notified };
}

/**
 * Re-read the card from the api and apply it (`applyRemoteCardState`). For
 * the paths that learn about a block without a webhook: the card sync's
 * status step and a status push the api refused with a 409 (`apiRefused`:
 * the api's block then wins even over a local fund block). `detail` is null
 * when the card is not on file or the api does not know it (nothing
 * applied). Throws when the api is unreachable.
 */
export async function reconcileCardWithCitizenPay(args: {
  fund: PinBlockEmailFund;
  cardId: string;
  source: CardEventSource;
  context?: CardEventContext;
  apiRefused?: boolean;
}): Promise<{
  transition: CardStateTransition;
  detail: CitizenPayCardDetail | null;
}> {
  const card = await prisma.card.findFirst({
    where: { id: args.cardId, fundId: args.fund.id },
    select: RECONCILABLE_CARD_SELECT,
  });
  if (!card) return { transition: { kind: "none" }, detail: null };
  const detail = await getCitizenPayClient(args.fund).getCitizenPayCard(
    card.serialNumber,
  );
  if (!detail) return { transition: { kind: "none" }, detail: null };
  const context = { ...args.context };
  if (!context.placeId) {
    const blocked = detail.pinEvents.find((e) => e.action === "blocked");
    if (blocked) {
      context.placeId = blocked.placeId;
      context.terminalId = context.terminalId ?? blocked.terminalId;
    }
  }
  if (context.placeId && !context.placeName) {
    context.placeName = await resolvePlaceName(args.fund.id, context.placeId);
  }
  const { transition } = await applyRemoteCardState({
    fund: args.fund,
    card,
    remote: { status: detail.status, pinBlockedAt: detail.pinBlockedAt },
    source: args.source,
    context,
    apiRefused: args.apiRefused,
  });
  return { transition, detail };
}

/**
 * The name of a Citizen Pay place (a merchant location) as the fund knows it,
 * from the merchant that carries that place id. Null when the fund has no
 * merchant for it — the terminal belonged to another fund's place, which is
 * possible for an enrolled card.
 */
export async function resolvePlaceName(
  fundId: string,
  placeId: string | null,
): Promise<string | null> {
  if (!placeId) return null;
  const merchant = await prisma.merchant.findFirst({
    where: { fundId, citizenPayPlaceId: placeId },
    select: { name: true },
  });
  return merchant?.name ?? null;
}
