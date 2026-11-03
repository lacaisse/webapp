// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { getCitizenPayClient, type FundCredentials } from "@/services/citizenpay/client";
import type { CitizenPayCardDetail } from "@/services/citizenpay/types";
import type {
  CardBlockedReason,
  CardEventSource,
  CardStatus,
} from "@/services/db/generated/enums";
import { prisma } from "@/services/db/prisma";

import {
  planCardStateSync,
  type CardStateTransition,
  type RemoteCardState,
} from "./pin-block-rules";

// A card's PIN block, as La Caisse sees it (D12). Citizen Pay blocks a card
// after three wrong PIN entries (`pin_blocked_at`) and tells the fund through
// the treasury events webhook (app/api/citizenpay/events); the card sync and
// a refused status push catch what the webhook missed. Both paths end here:
// the api's card is re-read, `planCardStateSync` (the pure rule) decides, and
// the local row plus a CardEvent audit line are written. Nothing in this
// module trusts a webhook payload — only the api's own card read.

export { isPinBlocked } from "./pin-block-rules";

export type LocalCard = {
  id: string;
  status: CardStatus;
  blockedReason: CardBlockedReason | null;
  blockedAt: Date | null;
};

export type CardEventContext = {
  actorUserId?: string | null;
  citizenPayEventId?: string | null;
  placeId?: string | null;
  placeName?: string | null;
  terminalId?: string | null;
};

/**
 * Apply what the api says about a card to the local row. A PIN block is
 * imported (BLOCKED, `blockedReason` PIN, `blockedAt` = the api's time) and a
 * lifted one pulled back to the api's status; a fund block is left alone
 * (local-authoritative — the sync pushes it). Writes a CardEvent for every
 * change so the card page can say what happened and when.
 */
export async function applyRemoteCardState(args: {
  fundId: string;
  card: LocalCard;
  remote: RemoteCardState;
  source: CardEventSource;
  context?: CardEventContext;
  now?: Date;
}): Promise<CardStateTransition> {
  const now = args.now ?? new Date();
  const transition = planCardStateSync(args.card, args.remote, now);
  if (transition.kind !== "pin_block" && transition.kind !== "pin_release") {
    return transition;
  }

  await prisma.card.update({
    where: { id: args.card.id },
    data: transition.data,
  });
  const ctx = args.context ?? {};
  try {
    await prisma.cardEvent.create({
      data: {
        fundId: args.fundId,
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
  return transition;
}

/**
 * Re-read the card from the api and apply it (`applyRemoteCardState`). For
 * the paths that learn about a block without a webhook: the card sync and a
 * status push the api refused with a 409. `detail` is null when the api does
 * not know the card (nothing applied). Throws when the api is unreachable.
 */
export async function reconcileCardWithCitizenPay(args: {
  fund: FundCredentials;
  card: LocalCard & { serialNumber: string };
  source: CardEventSource;
  context?: CardEventContext;
}): Promise<{
  transition: CardStateTransition;
  detail: CitizenPayCardDetail | null;
}> {
  const detail = await getCitizenPayClient(args.fund).getCitizenPayCard(
    args.card.serialNumber,
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
  const transition = await applyRemoteCardState({
    fundId: args.fund.id,
    card: args.card,
    remote: { status: detail.status, pinBlockedAt: detail.pinBlockedAt },
    source: args.source,
    context,
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
