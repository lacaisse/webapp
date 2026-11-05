// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { AttemptLimiter } from "@/services/auth/attempt-limiter";
import { clientIp } from "@/services/http/client-ip";

import { findUsableWaiverCode } from "./waiver-claim";
import { formatWaiverCode } from "./waiver-codes";

// The apex /join door (app/(apex)/start — proxy.ts rewrites /join there on
// the apex): anyone creates their account and their fund in one go. The fund
// starts the way one opened from /new does — unsettled, with the dashboard's
// setup checklist asking for the Citizen Pay registration, open banking and
// the hosting subscription. The one extra is an invite code ("I have an
// invite code"): a subscription waiver code, admin-minted, limited in uses,
// expiring and revocable (waiver-codes.ts), waives the subscription from the
// start. It is treated like the staff-invite token: checked without being
// consumed when the page opens with ?code= (a shared link) or when the field
// is filled in, claimed inside the transaction that creates the account and
// the fund (join-actions.ts).
//
// Posture of a public page:
//   - one answer for every unusable code. Unknown, revoked, expired and used
//     up all read "not valid" (findUsableWaiverCode returns null for each):
//     the page never confirms that a guessed code exists. Sixty random bits
//     make guessing hopeless anyway; this keeps the error text from saying
//     more than the holder needs.
//   - the code travels in URLs by design — /join?code= (a shared link),
//     /new?code=, the login's return_to — so the pages that carry it send no
//     Referer (`metadata.referrer: "no-referrer"`), and nothing of ours
//     writes it to a log: the lookup and the limiters keep it in memory.
//   - an address that already has an account is answered by email, never on
//     screen (join-actions.ts), so the form cannot be used to learn which
//     addresses have accounts.
//   - attempt limits, in memory per instance like the member login's
//     (services/member/auth-actions.ts). Per IP on checks that FAIL (an
//     unusable code — a classroom behind one NAT opening a shared link is
//     not a failure) and on submits that END: refused for the code, an
//     account and fund created, or answered by email; a form that merely
//     needs another subdomain spends nothing. Per code on every submit that
//     carries one, so one code cannot be turned into funds faster than
//     people would. Per address on the "you already have an account" email.
//   - no code is no gate: the door is open, and a fund made here costs its
//     maker the subscription (or a code) before it runs — the IP budget
//     above is what keeps a script from filling the subdomain space.

// 30 failed code checks per IP per 10 minutes; 10 ended submits per IP per
// hour; 10 submits per code per 10 minutes; one existing-account email per
// address per 10 minutes.
const checkLimiter = new AttemptLimiter(30, 10 * 60_000);
const submitIpLimiter = new AttemptLimiter(10, 60 * 60_000);
const submitCodeLimiter = new AttemptLimiter(10, 10 * 60_000);
const existingAccountEmailLimiter = new AttemptLimiter(1, 10 * 60_000);

export type JoinCodeLookup =
  // `code` formatted for display (XXXX-XXXX-XXXX); `label` is the admin's
  // "who or why", shown so the holder sees the code is theirs.
  | { kind: "ok"; code: string; label: string }
  | { kind: "invalid" }
  | { kind: "too_many" };

/** The page's check of `?code=`: never consuming; a miss counts per IP. */
export async function lookupJoinCode(raw: string): Promise<JoinCodeLookup> {
  const ip = await clientIp();
  if (!checkLimiter.allowed(ip)) return { kind: "too_many" };
  const code = await findUsableWaiverCode(raw);
  if (!code) {
    checkLimiter.fail(ip);
    return { kind: "invalid" };
  }
  return { kind: "ok", code: formatWaiverCode(code.code), label: code.label };
}

/**
 * Whether a submit may start, checked before anything is read: false =
 * refuse. A submit that carries a (normalised) code counts against it right
 * away; every submit counts against the IP only once it ends
 * (`countJoinSubmit`).
 */
export async function allowJoinSubmit(normalisedCode: string | null): Promise<boolean> {
  const ip = await clientIp();
  if (!submitIpLimiter.allowed(ip)) return false;
  if (normalisedCode !== null) {
    if (!submitCodeLimiter.allowed(normalisedCode)) return false;
    submitCodeLimiter.fail(normalisedCode);
  }
  return true;
}

/** A submit ended (refused for the code, created, or answered by email). */
export async function countJoinSubmit(): Promise<void> {
  submitIpLimiter.fail(await clientIp());
}

/** Whether the existing-account email may go to `email` right now. */
export function allowExistingAccountEmail(email: string): boolean {
  if (!existingAccountEmailLimiter.allowed(email)) return false;
  existingAccountEmailLimiter.fail(email);
  return true;
}
