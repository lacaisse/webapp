// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { AttemptLimiter } from "@/services/auth/attempt-limiter";
import { clientIp } from "@/services/http/client-ip";

import { findUsableWaiverCode } from "./waiver-claim";
import { formatWaiverCode } from "./waiver-codes";

// The apex /join door (app/(apex)/start — proxy.ts rewrites /join there on
// the apex): a person who holds a subscription waiver code creates their
// account and their fund in one go, waived from the start, without anyone
// creating the fund and inviting them first. The code is the invite. It is
// admin-minted, limited in uses, expiring and revocable (waiver-codes.ts), so
// this door treats it like the staff-invite token: checked without being
// consumed when the page opens, claimed inside the transaction that creates
// the account and the fund (join-actions.ts), never logged in full.
//
// Posture of a public page:
//   - one answer for every unusable code. Unknown, revoked, expired and used
//     up all read "not valid" (findUsableWaiverCode returns null for each):
//     the page never confirms that a guessed code exists. Sixty random bits
//     make guessing hopeless anyway; this keeps the error text and the logs
//     from saying more than the holder needs.
//   - attempt limits, in memory per instance like the member login's
//     (services/member/auth-actions.ts): per IP on every check and every
//     submit, and per code on submits, so one code cannot be turned into
//     funds faster than people would.

// 30 code checks per IP per 10 minutes (opening the page with ?code= is
// one); 10 account+fund creations per IP per hour; 10 per code per 10
// minutes.
const checkLimiter = new AttemptLimiter(30, 10 * 60_000);
const submitIpLimiter = new AttemptLimiter(10, 60 * 60_000);
const submitCodeLimiter = new AttemptLimiter(10, 10 * 60_000);

export type JoinCodeLookup =
  // `code` formatted for display (XXXX-XXXX-XXXX); `label` is the admin's
  // "who or why", shown so the holder sees the code is theirs.
  | { kind: "ok"; code: string; label: string }
  | { kind: "invalid" }
  | { kind: "too_many" };

/** The page's check of `?code=`: rate-limited per IP, never consuming. */
export async function lookupJoinCode(raw: string): Promise<JoinCodeLookup> {
  const ip = await clientIp();
  if (!checkLimiter.allowed(ip)) return { kind: "too_many" };
  checkLimiter.fail(ip);
  const code = await findUsableWaiverCode(raw);
  if (!code) return { kind: "invalid" };
  return { kind: "ok", code: formatWaiverCode(code.code), label: code.label };
}

/**
 * The submit's limits, counted before anything is read: false = refuse. Keyed
 * by the caller's IP and by the (normalised) code the submit names.
 */
export async function allowJoinSubmit(normalisedCode: string): Promise<boolean> {
  const ip = await clientIp();
  if (!submitIpLimiter.allowed(ip) || !submitCodeLimiter.allowed(normalisedCode)) return false;
  submitIpLimiter.fail(ip);
  submitCodeLimiter.fail(normalisedCode);
  return true;
}
