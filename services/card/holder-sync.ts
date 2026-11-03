// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { after } from "next/server";

import { CitizenPayApiError } from "@/services/citizenpay/api";
import { getCitizenPayClient } from "@/services/citizenpay/client";
import { prisma } from "@/services/db/prisma";

// Card holder sync (plan "Bread card-holder voting", D3). A card is ATTACHED
// to a member login when its Member has a User (`Member.userId`) whose
// address the member verified (`Member.emailVerifiedAt`), at a fund that
// turned member login on. The webapp is the record of that fact; Citizen Pay
// learns it through `PUT /v2/treasury/cards/{serial}/holder {holder_ref}`
// (holder_ref = the User id, the wallet JWT's `sub`) and forgets it through
// `DELETE` on the same path — an attached card is private on the public
// wallet and can vote.
//
// `syncCardHolder` recomputes the desired state from the database and sends
// it, so it is idempotent and safe to call on every transition: member
// activation, addCard, unassign, the sign-up link, email verification, login
// removal. Like the holder-name publish it is best-effort and runs off the
// request path (`schedule*` → `after()`); our rows are never blocked on CP.
//
// The api route ships in a separate api PR. Until it is deployed the api
// answers 404: that is logged once per process as "not deployed" and the
// card keeps `holderSyncedAt = null`, so `scripts/sync-card-holders.ts` can
// replay every un-synced card once the route is live. A 2xx stamps
// `holderSyncedAt` whether the call was a PUT or a DELETE.

export type HolderSyncFund = {
  id: string;
  memberLoginEnabled: boolean;
  citizenPayApiKeyId: string | null;
  citizenPayApiKeyEnc: string | null;
};

// The desired holder state of a card, from the rows alone (no I/O).
export type HolderState =
  | { kind: "attached"; holderRef: string }
  | { kind: "detached" };

export type HolderSyncOutcome =
  | "ok"
  // Nothing to do: the fund has member login off, no CP key, the card is
  // not the fund's, or the card is an enrolled copy (only the issuer
  // attaches, Q11) — nothing is sent.
  | "skipped"
  // The api does not have the route yet (404). Nothing is marked synced.
  | "not_deployed"
  // A failure code: the HTTP status, "network", or "error".
  | string;

type CardForHolderSync = {
  id: string;
  serialNumber: string;
  memberId: string | null;
  member: { userId: string | null; emailVerifiedAt: Date | null } | null;
  // Set on a card created by accepting another fund's enrollment request:
  // that card is a copy of a serial another fund issued, and only the
  // issuer's key may set the holder at CP.
  enrolledFromRequest: { id: string } | null;
};

/**
 * Pure rule: attached iff the fund has member login on, the card is bound
 * to a member with a login whose email is verified.
 */
export function desiredHolderState(
  fund: Pick<HolderSyncFund, "memberLoginEnabled">,
  card: Pick<CardForHolderSync, "memberId" | "member">,
): HolderState {
  if (!fund.memberLoginEnabled) return { kind: "detached" };
  const member = card.memberId ? card.member : null;
  if (member?.userId && member.emailVerifiedAt) {
    return { kind: "attached", holderRef: member.userId };
  }
  return { kind: "detached" };
}

function isConnected(fund: HolderSyncFund): boolean {
  return Boolean(fund.citizenPayApiKeyId && fund.citizenPayApiKeyEnc);
}

function failureCode(e: unknown): string {
  if (e instanceof CitizenPayApiError) return String(e.status);
  if (
    e instanceof Error &&
    (e.name === "AbortError" || e.name === "TimeoutError" || e instanceof TypeError)
  ) {
    return "network";
  }
  return "error";
}

// Logged once per process: every card of every fund would otherwise repeat
// it until the api PR is deployed.
let warnedNotDeployed = false;

async function loadFund(fundId: string): Promise<HolderSyncFund | null> {
  return prisma.fund.findUnique({
    where: { id: fundId },
    select: {
      id: true,
      memberLoginEnabled: true,
      citizenPayApiKeyId: true,
      citizenPayApiKeyEnc: true,
    },
  });
}

const cardSelect = {
  id: true,
  serialNumber: true,
  memberId: true,
  member: { select: { userId: true, emailVerifiedAt: true } },
  enrolledFromRequest: { select: { id: true } },
} as const;

/**
 * Push one card's holder state to Citizen Pay now (awaited). Never throws;
 * returns the outcome and logs failures once each.
 */
export async function syncCardHolder(cardId: string): Promise<HolderSyncOutcome> {
  const card = await prisma.card.findUnique({
    where: { id: cardId },
    select: { ...cardSelect, fundId: true },
  });
  if (!card) return "skipped";
  const fund = await loadFund(card.fundId);
  if (!fund) return "skipped";
  return syncOne(fund, card);
}

/**
 * Push every card of a member (awaited). Used on the transitions that
 * change the member rather than a card: the sign-up link, the email
 * verification, the login removal.
 */
export async function syncMemberCardHolders(memberId: string): Promise<HolderSyncOutcome[]> {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: { fundId: true, cards: { select: cardSelect } },
  });
  if (!member || member.cards.length === 0) return [];
  const fund = await loadFund(member.fundId);
  if (!fund) return [];
  const out: HolderSyncOutcome[] = [];
  for (const card of member.cards) out.push(await syncOne(fund, card));
  return out;
}

async function syncOne(
  fund: HolderSyncFund,
  card: CardForHolderSync,
): Promise<HolderSyncOutcome> {
  // A fund without member login never attached anything, so there is
  // nothing to detach either: don't spend a CP call per unassign.
  if (!fund.memberLoginEnabled || !isConnected(fund)) return "skipped";
  if (card.enrolledFromRequest) return "skipped";

  const state = desiredHolderState(fund, card);
  try {
    await getCitizenPayClient(fund).setCardHolder(
      card.serialNumber,
      state.kind === "attached" ? state.holderRef : null,
    );
  } catch (e) {
    const code = failureCode(e);
    if (code === "404") {
      if (!warnedNotDeployed) {
        warnedNotDeployed = true;
        console.warn(
          "[citizenpay] card holder route not deployed (404) — leaving holderSyncedAt null; replay with scripts/sync-card-holders.ts",
        );
      }
      return "not_deployed";
    }
    // Never CP's message text (it could echo the serial) — the code only.
    console.warn(`[citizenpay] card holder sync failed (best-effort): ${code}`);
    return code;
  }
  await prisma.card.update({
    where: { id: card.id },
    data: { holderSyncedAt: new Date() },
  });
  return "ok";
}

/**
 * Sync the given cards after the response is sent (`after()`), so a slow or
 * missing api route never delays the user's action. Call from server
 * actions and route handlers. Failures are logged by `syncCardHolder`.
 */
export function scheduleCardHolderSync(cardIds: string | Iterable<string>): void {
  const ids = [...new Set(typeof cardIds === "string" ? [cardIds] : cardIds)];
  if (ids.length === 0) return;
  after(async () => {
    for (const id of ids) await syncCardHolder(id);
  });
}

/** Same, for every card of a member. */
export function scheduleMemberCardHolderSync(memberId: string): void {
  after(async () => {
    await syncMemberCardHolders(memberId);
  });
}
