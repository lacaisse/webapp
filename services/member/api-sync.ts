// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { after } from "next/server";

import { normalizeSerial } from "@/services/card/serial";
import { CitizenPayApiError } from "@/services/citizenpay/api";
import { getCitizenPayClient } from "@/services/citizenpay/client";
import { prisma } from "@/services/db/prisma";

// Members at the api (plan "Bread card-holder voting", W-2 item 1). The card
// holder sync (services/card/holder-sync.ts) tells Citizen Pay which login
// holds each card; this module tells it which logins are MEMBERS of the fund
// at all, with the serials of the fund's own cards bound to them. A wallet
// claim from a declared login, for one of those cards, needs no proof: the
// fund already vouched for that person (`PUT /v2/treasury/members/
// {holder_ref} {cards}`). When the login goes away the declaration is
// withdrawn (`DELETE` on the same path).
//
// A member is DECLARED iff the fund has member login on, the Member has a
// User (`Member.userId`) and the member verified their address
// (`Member.emailVerifiedAt`) — the same rule that attaches their cards. The
// holder ref is the User id, the wallet JWT's `sub`. Cards are the issuer's
// rows only: an enrolled copy (`enrolledFromRequest`) is another fund's
// serial, which this fund's key cannot vouch for.
//
// Like the holder sync, the state is recomputed from the rows and sent whole
// (the PUT replaces the card list), so every call is idempotent and safe to
// fire on every transition: activation, addCard, unassign, the verification
// click, "remove my login", the member-login toggle. It is best-effort and
// runs off the request path (`schedule*` → `after()`): our rows never wait
// on Citizen Pay.
//
// The api route ships in a separate api PR. Until it is deployed the api
// answers 404: logged once per process as "not deployed", `apiSyncedAt`
// stays null, and `scripts/sync-members.ts` replays every un-synced member
// once the route is live. Any 2xx stamps `Member.apiSyncedAt`, PUT or DELETE.

type MemberApiSyncFund = {
  id: string;
  memberLoginEnabled: boolean;
  citizenPayApiKeyId: string | null;
  citizenPayApiKeyEnc: string | null;
};

// The desired declaration of a member, from the rows alone (no I/O).
// `undeclared` carries the ref to withdraw, when there is one: a member that
// never had a login has nothing to undeclare.
export type MemberApiState =
  | { kind: "declared"; holderRef: string; cards: string[] }
  | { kind: "undeclared"; holderRef: string | null };

export type MemberApiSyncOutcome =
  | "ok"
  // Nothing to do: unknown member, fund without a CP key, or an undeclared
  // member with no holder ref to withdraw — nothing is sent.
  | "skipped"
  // The api does not have the route yet (404). Nothing is marked synced.
  | "not_deployed"
  // A failure code: the HTTP status, "network", or "error".
  | string;

type MemberForApiSync = {
  userId: string | null;
  emailVerifiedAt: Date | null;
  cards: { serialNumber: string; enrolledFromRequest: { id: string } | null }[];
};

/**
 * Pure rule: declared iff the fund has member login on and the member has a
 * login whose email is verified; the cards are the member's issuer cards,
 * normalized and sorted (a stable body, so a replay sends the same bytes).
 */
export function desiredMemberApiState(
  fund: Pick<MemberApiSyncFund, "memberLoginEnabled">,
  member: MemberForApiSync,
): MemberApiState {
  if (fund.memberLoginEnabled && member.userId && member.emailVerifiedAt) {
    const cards = [
      ...new Set(
        member.cards
          .filter((c) => !c.enrolledFromRequest)
          .map((c) => normalizeSerial(c.serialNumber)),
      ),
    ].sort();
    return { kind: "declared", holderRef: member.userId, cards };
  }
  return { kind: "undeclared", holderRef: member.userId };
}

function isConnected(fund: MemberApiSyncFund): boolean {
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

// Logged once per process: every member of every fund would otherwise
// repeat it until the api PR is deployed.
let warnedNotDeployed = false;

async function loadFund(fundId: string): Promise<MemberApiSyncFund | null> {
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

const memberSelect = {
  id: true,
  userId: true,
  emailVerifiedAt: true,
  cards: { select: { serialNumber: true, enrolledFromRequest: { select: { id: true } } } },
} as const;

/**
 * Push one member's declaration to Citizen Pay now (awaited). Never throws;
 * returns the outcome and logs failures by code. `removedHolderRef` is the
 * login that was just unlinked: the Member row no longer names it (and the
 * User row may be gone), so the ref to withdraw must come from the caller.
 */
export async function syncMemberAtApi(
  memberId: string,
  opts: { removedHolderRef?: string } = {},
): Promise<MemberApiSyncOutcome> {
  try {
    const member = await prisma.member.findUnique({
      where: { id: memberId },
      select: { ...memberSelect, fundId: true },
    });
    if (!member) return "skipped";
    const fund = await loadFund(member.fundId);
    if (!fund) return "skipped";
    return await syncOne(fund, member, opts);
  } catch (e) {
    // A database hiccup must not surface in the action that scheduled us.
    console.warn(`[citizenpay] member api sync failed (best-effort): ${failureCode(e)}`);
    return "error";
  }
}

async function syncOne(
  fund: MemberApiSyncFund,
  member: MemberForApiSync & { id: string },
  opts: { removedHolderRef?: string } = {},
): Promise<MemberApiSyncOutcome> {
  // A fund with member login OFF still syncs — as "undeclared": turning the
  // flag off withdraws every declaration made while it was on, and the
  // toggle schedules a fund-wide sync for exactly that.
  if (!isConnected(fund)) return "skipped";

  const desired = desiredMemberApiState(fund, member);
  // The ref the row no longer carries (login just removed) is the one to
  // withdraw; a row that still names a login withdraws that one.
  const state: MemberApiState =
    desired.kind === "undeclared"
      ? { kind: "undeclared", holderRef: desired.holderRef ?? opts.removedHolderRef ?? null }
      : desired;
  if (!state.holderRef) return "skipped";
  try {
    const cp = getCitizenPayClient(fund);
    if (state.kind === "declared") {
      await cp.setTreasuryMember(state.holderRef, state.cards);
    } else {
      await cp.removeTreasuryMember(state.holderRef);
    }
  } catch (e) {
    const code = failureCode(e);
    if (code === "404") {
      if (!warnedNotDeployed) {
        warnedNotDeployed = true;
        console.warn(
          "[citizenpay] treasury members route not deployed (404) — leaving apiSyncedAt null; replay with scripts/sync-members.ts",
        );
      }
      return "not_deployed";
    }
    // The code only, never CP's message text (it could echo serials); the
    // holder ref is a user id, safe to log, but adds nothing here.
    console.warn(`[citizenpay] member api sync failed (best-effort): ${code}`);
    return code;
  }
  await prisma.member.update({
    where: { id: member.id },
    data: { apiSyncedAt: new Date() },
  });
  return "ok";
}

/**
 * Push every member of a fund that may be declared, or may have been:
 * members with a login, and members Citizen Pay accepted a declaration for
 * before (`apiSyncedAt`). Used when the fund's member-login flag flips: on →
 * declare the verified logins, off → withdraw them all. Members that never
 * had a login were never declared and are left alone.
 *
 * A stamped member whose login is gone has no ref left on the row; it is
 * skipped here — "remove my login" withdrew it at the time.
 */
export async function syncFundMembersAtApi(fundId: string): Promise<MemberApiSyncOutcome[]> {
  try {
    const fund = await loadFund(fundId);
    if (!fund) return [];
    const members = await prisma.member.findMany({
      where: {
        fundId,
        OR: [{ userId: { not: null } }, { apiSyncedAt: { not: null } }],
      },
      select: memberSelect,
    });
    const out: MemberApiSyncOutcome[] = [];
    for (const member of members) out.push(await syncOne(fund, member));
    return out;
  } catch (e) {
    console.warn(`[citizenpay] fund member api sync failed (best-effort): ${failureCode(e)}`);
    return ["error"];
  }
}

/**
 * Sync the given members after the response is sent (`after()`), so a slow
 * or missing api route never delays the user's action. Call from server
 * actions and route handlers. Failures are logged by `syncMemberAtApi`.
 */
export function scheduleMemberApiSync(
  memberIds: string | Iterable<string>,
  opts: { removedHolderRef?: string } = {},
): void {
  const ids = [...new Set(typeof memberIds === "string" ? [memberIds] : memberIds)];
  if (ids.length === 0) return;
  after(async () => {
    for (const id of ids) await syncMemberAtApi(id, opts);
  });
}

/** Same, for a whole fund (the member-login toggle). */
export function scheduleFundMemberApiSync(fundId: string): void {
  after(async () => {
    await syncFundMembersAtApi(fundId);
  });
}
