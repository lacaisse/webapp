// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { CitizenPayApiError } from "@/services/citizenpay/api";
import {
  getCitizenPayClient,
  type FundCredentials,
} from "@/services/citizenpay/client";
import type {
  CitizenPayEventOutcome,
  CitizenPayEventPayload,
  EventFund,
} from "@/services/citizenpay/events";
import type { CardHolderInfo, CitizenPayCardDetail } from "@/services/citizenpay/types";
import type {
  CardEventKind,
  CardEventSource,
  CardHolderClaimStatus,
} from "@/services/db/generated/enums";
import { prisma } from "@/services/db/prisma";
import { scheduleMemberApiSync } from "@/services/member/api-sync";

import { sendCardClaimedFromWalletEmails } from "./holder-claim-emails";
import { desiredHolderState } from "./holder-sync";
import { nextCardNumber } from "./numbering";
import { scheduleCardHolderNamePublish } from "./publish-holder-name";
import { normalizeSerial } from "./serial";

// Wallet claims of the fund's cards (plan "Bread card-holder voting", PR
// W-2). A holder signs in to the card wallet with their La Caisse login and
// claims a card; Citizen Pay attaches it on its own proof (`app`: already
// linked in the app, `bound`: the fund declared that card for that login,
// `payment`: one recent card payment) or leaves the claim for the fund to
// confirm. The api tells the fund through the events webhook — `card.attached`,
// `card.detached`, and a pending claim as `card.claim_pending` or
// `card.attached` with `proof: "pending"` — and, as for the PIN events, the
// payload is never applied: `handleCardHolderEvent` re-reads `GET
// /v2/treasury/cards/{serial}/holder` and applies THAT.
//
// The local record of an attachment is the card's member binding: an
// attached card is bound to the Member of THIS fund whose login
// (`Member.userId`) the api names — never to another fund's member, even one
// that shares the login. An attachment the fund already holds (its own
// confirmation, or the holder sync's own PUT round-tripping) changes nothing
// and mails no one. A claim left for the fund becomes one PENDING
// CardHolderClaim per (fund, serial) that staff confirm or refuse from /cards
// (./holder-claim-actions.ts); every decision and every binding change is a
// CardEvent on the card's audit trail.

export const HOLDER_EVENT_TYPES = ["card.attached", "card.detached", "card.claim_pending"] as const;

export function isHolderEventType(type: string): boolean {
  return (HOLDER_EVENT_TYPES as readonly string[]).includes(type);
}

export type CardHolderClaimListItem = {
  id: string;
  status: CardHolderClaimStatus;
  serial: string;
  cardId: string | null;
  cardNumber: number | null;
  holderRef: string;
  proof: string | null;
  member: { id: string; firstName: string; lastName: string; email: string } | null;
  requestedAt: Date;
  decidedAt: Date | null;
};

const DECIDED_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The fund's wallet claims for the /cards inbox: PENDING first (oldest
 * first — the one waiting longest on top), then those decided in the last 30
 * days (newest decision first).
 */
export async function listCardHolderClaims(fundId: string): Promise<CardHolderClaimListItem[]> {
  const since = new Date(Date.now() - DECIDED_WINDOW_MS);
  const rows = await prisma.cardHolderClaim.findMany({
    where: {
      fundId,
      OR: [{ status: "PENDING" }, { decidedAt: { gte: since } }],
    },
    select: {
      id: true,
      status: true,
      serial: true,
      cardId: true,
      holderRef: true,
      proof: true,
      requestedAt: true,
      decidedAt: true,
      card: { select: { number: true } },
      member: { select: { id: true, firstName: true, lastName: true, email: true } },
    },
    orderBy: { requestedAt: "asc" },
  });
  const items = rows.map(
    (r): CardHolderClaimListItem => ({
      id: r.id,
      status: r.status,
      serial: r.serial,
      cardId: r.cardId,
      cardNumber: r.card?.number ?? null,
      holderRef: r.holderRef,
      proof: r.proof,
      member: r.member ?? null,
      requestedAt: r.requestedAt,
      decidedAt: r.decidedAt,
    }),
  );
  const pending = items.filter((i) => i.status === "PENDING");
  const decided = items
    .filter((i) => i.status !== "PENDING")
    .sort(
      (a, b) =>
        (b.decidedAt ?? b.requestedAt).getTime() - (a.decidedAt ?? a.requestedAt).getTime(),
    );
  return [...pending, ...decided];
}

// =============================================================================
// Local building blocks (also used by ./holder-claim-actions.ts)
// =============================================================================

export const HOLDER_CARD_SELECT = {
  id: true,
  serialNumber: true,
  holderName: true,
  memberId: true,
  formerMemberId: true,
  member: { select: { id: true, userId: true, emailVerifiedAt: true } },
} as const;

export type HolderCard = {
  id: string;
  serialNumber: string;
  holderName: string | null;
  memberId: string | null;
  formerMemberId: string | null;
  member: { id: string; userId: string | null; emailVerifiedAt: Date | null } | null;
};

export type HolderMember = {
  id: string;
  userId: string | null;
  firstName: string;
  lastName: string;
  emailVerifiedAt: Date | null;
};

// `Member.userId` is a uuid column: a holder ref of any other shape matches
// no member, and asking Postgres would only fail the event (and make the api
// retry it forever).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The Member of THIS fund whose login is `holderRef`; null when none. */
export async function findFundMemberByLogin(
  fundId: string,
  holderRef: string,
): Promise<HolderMember | null> {
  if (!UUID_RE.test(holderRef)) return null;
  return prisma.member.findFirst({
    where: { fundId, userId: holderRef },
    select: { id: true, userId: true, firstName: true, lastName: true, emailVerifiedAt: true },
  });
}

/** The fund's card row for a serial (case-insensitive), or null. */
export async function findFundCard(fundId: string, serial: string): Promise<HolderCard | null> {
  return prisma.card.findFirst({
    where: {
      fundId,
      serialNumber: { equals: normalizeSerial(serial), mode: "insensitive" },
    },
    select: HOLDER_CARD_SELECT,
  });
}

// A card created here can lose a unique race on (fundId, serialNumber) — a
// concurrent import or claim landed first, re-found below — or on (fundId,
// number), when the max + 1 number was just taken: the second attempt
// recomputes it.
const MAX_CREATE_ATTEMPTS = 2;

/**
 * The fund's card row for a serial, created unattached when there is none —
 * a card claimed from the wallet can be one the fund never imported. Status,
 * account and issue date come from a best-effort `getCitizenPayCard` (an
 * unreachable api leaves the account null and the card ACTIVE: the api just
 * attached it, so it is in use), as the /cards sync import does.
 */
export async function ensureFundCard(
  fund: FundCredentials,
  serial: string,
): Promise<{ card: HolderCard; created: boolean }> {
  const existing = await findFundCard(fund.id, serial);
  if (existing) return { card: existing, created: false };

  let remote: CitizenPayCardDetail | null = null;
  try {
    remote = await getCitizenPayClient(fund).getCitizenPayCard(serial);
  } catch (e) {
    console.error("[card.holder-claims] card read failed, creating it bare", serial, e);
  }
  const issuedAt = remote && !Number.isNaN(Date.parse(remote.createdAt))
    ? new Date(remote.createdAt)
    : new Date();

  for (let attempt = 1; ; attempt++) {
    try {
      const card = await prisma.card.create({
        data: {
          fundId: fund.id,
          memberId: null,
          serialNumber: normalizeSerial(serial),
          account: remote?.account ?? null,
          number: await nextCardNumber(fund.id),
          holderName: null,
          status: remote?.status ?? "ACTIVE",
          sourceSerial: remote?.sourceSerial ?? null,
          issuedAt,
        },
        select: HOLDER_CARD_SELECT,
      });
      return { card, created: true };
    } catch (e) {
      if ((e as { code?: string }).code !== "P2002" || attempt >= MAX_CREATE_ATTEMPTS) throw e;
      const raced = await findFundCard(fund.id, serial);
      if (raced) return { card: raced, created: false };
    }
  }
}

export type HolderEventInput = {
  kind: CardEventKind;
  source: CardEventSource;
  actorUserId?: string | null;
  citizenPayEventId?: string | null;
  detail?: string | null;
  at?: Date;
};

/**
 * One holder line on the card's audit trail. The binding it records is
 * already written, so a failed write is logged, never thrown (as the PIN
 * block's audit line). Answers the row id (for a rollback), null on failure.
 */
export async function writeHolderEvent(
  fundId: string,
  cardId: string,
  event: HolderEventInput,
): Promise<string | null> {
  try {
    const row = await prisma.cardEvent.create({
      data: {
        fundId,
        cardId,
        kind: event.kind,
        source: event.source,
        actorUserId: event.actorUserId ?? null,
        citizenPayEventId: event.citizenPayEventId ?? null,
        detail: event.detail ?? null,
        at: event.at ?? new Date(),
      },
      select: { id: true },
    });
    return row.id;
  } catch (e) {
    console.error("[card.holder-claims] CardEvent write failed", cardId, e);
    return null;
  }
}

/**
 * Bind the card to the member a claim resolved to, with its audit line.
 * `formerMemberId` is cleared (the card is held again — see
 * Card.formerMemberId); a previous holder loses the card, and their
 * `primaryCardId` when it pointed here, as `unassignCardAction` does.
 */
export async function bindCardToHolder(args: {
  fundId: string;
  card: { id: string; memberId: string | null };
  memberId: string;
  event: HolderEventInput;
}): Promise<{ previousMemberId: string | null; eventId: string | null }> {
  const previous =
    args.card.memberId && args.card.memberId !== args.memberId ? args.card.memberId : null;
  await prisma.$transaction([
    prisma.card.update({
      where: { id: args.card.id },
      data: { memberId: args.memberId, formerMemberId: null },
    }),
    // A member without a primary card gets this one, as activation does.
    prisma.member.updateMany({
      where: { id: args.memberId, primaryCardId: null },
      data: { primaryCardId: args.card.id },
    }),
    ...(previous
      ? [
          prisma.member.updateMany({
            where: { id: previous, primaryCardId: args.card.id },
            data: { primaryCardId: null },
          }),
        ]
      : []),
  ]);
  const eventId = await writeHolderEvent(args.fundId, args.card.id, args.event);
  return { previousMemberId: previous, eventId };
}

/**
 * Unbind the card from its member, like `unassignCardAction`: the outgoing
 * holder goes to `formerMemberId` (bank transfers keep naming the old
 * serial), their `primaryCardId` is cleared when it was this card, and the
 * audit line is written. Answers what a rollback needs.
 */
export async function unbindCardFromHolder(args: {
  fundId: string;
  card: { id: string; memberId: string };
  event: HolderEventInput;
}): Promise<{ primaryCleared: boolean; eventId: string | null }> {
  const [, cleared] = await prisma.$transaction([
    prisma.card.update({
      where: { id: args.card.id },
      data: { memberId: null, formerMemberId: args.card.memberId },
    }),
    prisma.member.updateMany({
      where: { id: args.card.memberId, primaryCardId: args.card.id },
      data: { primaryCardId: null },
    }),
  ]);
  const eventId = await writeHolderEvent(args.fundId, args.card.id, args.event);
  return { primaryCleared: cleared.count > 0, eventId };
}

/**
 * Close the PENDING claims of a serial with `status`. `holderRef` limits it
 * to that claimant's; `exceptHolderRef` spares that one (the claim the api
 * still shows as pending).
 */
export async function closePendingClaims(args: {
  fundId: string;
  serial: string;
  status: Exclude<CardHolderClaimStatus, "PENDING">;
  holderRef?: string;
  exceptHolderRef?: string | null;
  decidedById?: string | null;
}): Promise<number> {
  const holderRef =
    args.holderRef !== undefined
      ? args.holderRef
      : args.exceptHolderRef
        ? { not: args.exceptHolderRef }
        : undefined;
  const res = await prisma.cardHolderClaim.updateMany({
    where: {
      fundId: args.fundId,
      serial: normalizeSerial(args.serial),
      status: "PENDING",
      ...(holderRef !== undefined ? { holderRef } : {}),
    },
    data: {
      status: args.status,
      decidedAt: new Date(),
      ...(args.decidedById ? { decidedById: args.decidedById } : {}),
    },
  });
  return res.count;
}

/**
 * Keep ONE PENDING claim per (fund, serial): the same claimant's open claim
 * is refreshed (newer event, newer request time), another claimant's is
 * SUPERSEDED and a new row opened. Never creates a card row — `cardId` is
 * the fund's row when it has one.
 */
export async function openPendingClaim(args: {
  fundId: string;
  serial: string;
  holderRef: string;
  memberId: string;
  cardId: string | null;
  citizenPayEventId: string | null;
  requestedAt: Date;
}): Promise<{ claimId: string; refreshed: boolean }> {
  const serial = normalizeSerial(args.serial);
  const open = await prisma.cardHolderClaim.findMany({
    where: { fundId: args.fundId, serial, status: "PENDING" },
    select: { id: true, holderRef: true },
    orderBy: { requestedAt: "desc" },
  });
  const same = open.find((c) => c.holderRef === args.holderRef) ?? null;
  const others = open.filter((c) => c.id !== same?.id).map((c) => c.id);
  if (others.length > 0) {
    await prisma.cardHolderClaim.updateMany({
      where: { id: { in: others }, status: "PENDING" },
      data: { status: "SUPERSEDED", decidedAt: new Date() },
    });
  }
  if (same) {
    await prisma.cardHolderClaim.update({
      where: { id: same.id },
      data: {
        citizenPayEventId: args.citizenPayEventId,
        requestedAt: args.requestedAt,
        memberId: args.memberId,
        cardId: args.cardId,
        proof: "pending",
      },
    });
    return { claimId: same.id, refreshed: true };
  }
  try {
    const row = await prisma.cardHolderClaim.create({
      data: {
        fundId: args.fundId,
        serial,
        cardId: args.cardId,
        holderRef: args.holderRef,
        memberId: args.memberId,
        proof: "pending",
        status: "PENDING",
        citizenPayEventId: args.citizenPayEventId,
        requestedAt: args.requestedAt,
      },
      select: { id: true },
    });
    return { claimId: row.id, refreshed: false };
  } catch (e) {
    // The partial unique index (one PENDING per fund + serial) caught a
    // concurrent delivery: that row is the claim, refreshed like a redelivery.
    if ((e as { code?: string }).code !== "P2002") throw e;
    const raced = await prisma.cardHolderClaim.findFirst({
      where: { fundId: args.fundId, serial, status: "PENDING" },
      select: { id: true },
    });
    if (!raced) throw e;
    await prisma.cardHolderClaim.update({
      where: { id: raced.id },
      data: {
        holderRef: args.holderRef,
        citizenPayEventId: args.citizenPayEventId,
        requestedAt: args.requestedAt,
        memberId: args.memberId,
        cardId: args.cardId,
        proof: "pending",
      },
    });
    return { claimId: raced.id, refreshed: true };
  }
}

// =============================================================================
// The webhook
// =============================================================================

type Outcome = CitizenPayEventOutcome;

const ignored = (detail: string): Outcome => ({ outcome: "IGNORED", detail });
const applied = (detail: string): Outcome => ({ outcome: "APPLIED", detail });

function isPendingPayload(p: CitizenPayEventPayload): boolean {
  return p.type === "card.claim_pending" || (p.type === "card.attached" && p.proof === "pending");
}

function parseDate(v: string | null | undefined): Date | null {
  if (!v || Number.isNaN(Date.parse(v))) return null;
  return new Date(v);
}

/**
 * Handle one verified holder event (`HOLDER_EVENT_TYPES`). The api's holder
 * read decides: an attached login binds the card to that login's member of
 * this fund; a pending claim opens (or refreshes) the fund's claim; neither
 * unbinds a login-bound card. The payload is only the fallback for a pending
 * claim the read does not show (an api that posts `card.claim_pending`
 * before its holder route exposes it). Throws when the api cannot be read or
 * a write fails — the route records FAILED and the api redelivers.
 */
export async function handleCardHolderEvent(
  fund: EventFund,
  payload: CitizenPayEventPayload,
): Promise<CitizenPayEventOutcome> {
  if (!payload.serial) return ignored("no serial on the event");
  if (!fund.citizenPayApiKeyId || !fund.citizenPayApiKeyEnc) {
    return ignored("fund not connected to Citizen Pay");
  }
  const serial = payload.serial;

  let holder: CardHolderInfo;
  try {
    holder = await getCitizenPayClient(fund).getCardHolder(serial);
  } catch (e) {
    // The api that posted the event has the route, so a 404 is a serial that
    // is not this treasury's own (an enrolled copy, a stray event).
    if (e instanceof CitizenPayApiError && e.status === 404) {
      return ignored("card not the issuer's at Citizen Pay");
    }
    throw e;
  }

  const pendingPayload = isPendingPayload(payload);
  if (holder.pendingHolderRef && (pendingPayload || !holder.holderRef)) {
    return applyPendingClaim(fund, payload, serial, holder.pendingHolderRef, holder.pendingSince);
  }
  if (holder.holderRef) {
    return applyAttachment(fund, payload, serial, holder);
  }
  if (pendingPayload && payload.holder_ref) {
    return applyPendingClaim(fund, payload, serial, payload.holder_ref, payload.at ?? null);
  }
  return applyDetachment(fund, payload, serial, holder);
}

async function applyAttachment(
  fund: EventFund,
  payload: CitizenPayEventPayload,
  serial: string,
  holder: CardHolderInfo,
): Promise<Outcome> {
  const holderRef = holder.holderRef as string;
  const member = await findFundMemberByLogin(fund.id, holderRef);
  if (!member) {
    console.warn(
      "[card.holder-claims] attached holder is not a member of this fund",
      fund.id,
      serial,
      holderRef,
    );
    return ignored("holder is not a member of this fund");
  }

  // With member login off the holder sync would detach it again at once:
  // the fund turned the feature off, so nothing is bound here.
  if (!fund.memberLoginEnabled) {
    return ignored("member login is off at this fund");
  }

  const { card } = await ensureFundCard(fund, serial);
  // The fund's own doing — its confirmation of a pending claim (proof
  // `confirmed`), or a claim by this login it already holds as PENDING or
  // CONFIRMED — is no news to its staff: no email for those. Read before
  // the claims are settled below.
  const ownConfirmation =
    holder.proof === "confirmed" ||
    (await prisma.cardHolderClaim.count({
      where: {
        fundId: fund.id,
        serial: normalizeSerial(serial),
        holderRef,
        status: { in: ["PENDING", "CONFIRMED"] },
      },
    })) > 0;
  // The claimant's open claims are settled by this attachment; another
  // claimant's are stale unless the api still shows theirs as pending.
  const settle = async () => {
    await closePendingClaims({ fundId: fund.id, serial, status: "ATTACHED", holderRef });
    await closePendingClaims({
      fundId: fund.id,
      serial,
      status: "SUPERSEDED",
      exceptHolderRef: holder.pendingHolderRef ?? holderRef,
    });
  };

  if (card.memberId === member.id) {
    // The fund's own confirmation or the holder sync's own PUT coming back.
    await settle();
    return ignored("already bound to this login");
  }

  const proof = holder.proof ?? null;
  const at = parseDate(holder.attachedAt) ?? new Date();
  const { previousMemberId } = await bindCardToHolder({
    fundId: fund.id,
    card,
    memberId: member.id,
    event: {
      kind: "HOLDER_ATTACHED",
      source: "WEBHOOK",
      citizenPayEventId: payload.id,
      detail: proof,
      at,
    },
  });
  await settle();

  const staff = ownConfirmation
    ? 0
    : await sendCardClaimedFromWalletEmails({
        fund,
        card,
        member,
        eventId: payload.id,
        proof,
        claimedAt: at,
      });
  // The holder's name on the wallet, as activation and addCard do.
  scheduleCardHolderNamePublish(fund, card.id);
  scheduleMemberApiSync(previousMemberId ? [member.id, previousMemberId] : member.id);
  return applied(
    `bound to member (proof: ${proof ?? "unknown"}); ${ownConfirmation ? "fund's own confirmation, no email" : `${staff} staff email(s)`}`,
  );
}

async function applyPendingClaim(
  fund: EventFund,
  payload: CitizenPayEventPayload,
  serial: string,
  holderRef: string,
  since: string | null,
): Promise<Outcome> {
  const member = await findFundMemberByLogin(fund.id, holderRef);
  if (!member) {
    console.warn(
      "[card.holder-claims] claimant is not a member of this fund",
      fund.id,
      serial,
      holderRef,
    );
    return ignored("holder is not a member of this fund");
  }
  const card = await findFundCard(fund.id, serial);
  const { refreshed } = await openPendingClaim({
    fundId: fund.id,
    serial,
    holderRef,
    memberId: member.id,
    cardId: card?.id ?? null,
    citizenPayEventId: payload.id,
    requestedAt: parseDate(since) ?? new Date(),
  });
  if (refreshed) return applied("claim pending (fund to confirm); already on file, refreshed");
  if (card) {
    await writeHolderEvent(fund.id, card.id, {
      kind: "CLAIM_PENDING",
      source: "WEBHOOK",
      citizenPayEventId: payload.id,
      detail: "pending",
    });
  }
  return applied("claim pending (fund to confirm)");
}

async function applyDetachment(
  fund: EventFund,
  payload: CitizenPayEventPayload,
  serial: string,
  holder: CardHolderInfo,
): Promise<Outcome> {
  // An event that announced an attachment or a claim the read does not show
  // says so: the api's state moved on (an out-of-order delivery).
  const say = (detail: string) =>
    payload.type === "card.attached"
      ? `api does not confirm the attachment (${detail})`
      : payload.type === "card.claim_pending"
        ? `api shows no pending claim (${detail})`
        : detail;

  // Nothing is pending at the api: any open claim here is stale. Only when
  // the read actually exposed its `pending` field (as null) or the event is
  // the detachment itself, which refuses every claim — an api read that
  // predates pending claims says nothing about them.
  if (holder.pendingKnown || payload.type === "card.detached") {
    await closePendingClaims({ fundId: fund.id, serial, status: "SUPERSEDED" });
  }

  const card = await findFundCard(fund.id, serial);
  if (!card?.memberId || !card.member) return ignored(say("already detached"));
  if (!card.member.userId) return ignored(say("card bound to a member without login"));
  // Only a card our own rule says is attached is unbound: when it says
  // detached (member login off, email not verified), the detachment is the
  // holder sync's own DELETE coming back — not the holder leaving the card —
  // and the member keeps it.
  if (desiredHolderState(fund, card).kind !== "attached") {
    return ignored(say("card not attachable here; the holder sync detached it"));
  }

  const memberId = card.memberId;
  await unbindCardFromHolder({
    fundId: fund.id,
    card: { id: card.id, memberId },
    event: {
      kind: "HOLDER_DETACHED",
      source: "WEBHOOK",
      citizenPayEventId: payload.id,
    },
  });
  // Back to CP's default wallet name, as the fund's own Detach does.
  scheduleCardHolderNamePublish(fund, card.id);
  scheduleMemberApiSync(memberId);
  return applied(say("holder detached; card unbound from its member"));
}
