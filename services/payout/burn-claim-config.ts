// SPDX-License-Identifier: AGPL-3.0-or-later

// Citizen Pay refuses a FORCED release of a burn claim until the claim is this
// old (409 `burn claim is too recent`): a live burn can take a few minutes to
// reach the chain, so a younger claim may belong to an attempt still running.
// Mirrored here only to show the admin when Release becomes available — the
// api is what enforces it.
//
// The wait only applies to a FORCED release (no proof, just "I looked"). A
// release pinned by `claimId` alone is immediate on the api: that door is for
// the client that holds the claim and knows its attempt is over. The payout
// page takes it when `attemptBurnedNothing` holds for the attempt behind the
// claim — the chain itself then says there is nothing to wait for.
export const FORCED_RELEASE_MIN_AGE_MS = 10 * 60 * 1000;

// What we know locally about the burn attempt behind an in-flight claim (see
// burn-attempt.ts, which builds it). Lives here, in a plain module, because
// the payout page's client component renders it.
export type BurnAttempt =
  | { kind: "none" }
  // Row still PENDING: the attempt is running, or died before it finished.
  | { kind: "running"; startedAt: string }
  // Failed before anything was handed to the bundler.
  | { kind: "notSent" }
  // Handed to the bundler (or confirmed): its current state there.
  | {
      kind: "sent";
      userOpHash: string | null;
      txHash: string | null;
      status: "success" | "reverted" | "timeout" | "pending" | "submitted" | "unknown";
    };

// True when what we found about the attempt proves it burned nothing, so its
// claim can be released without the 10-minute wait: the attempt failed before
// anything reached the bundler, or its userOp was included and REVERTED (an
// ERC-4337 revert undoes the inner call — no tokens moved). Anything else
// (still running, pending at the bundler, confirmed, unknown, or no attempt
// found at all) keeps the wait: the burn may still land.
export function attemptBurnedNothing(attempt: BurnAttempt | null | undefined): boolean {
  if (!attempt) return false;
  if (attempt.kind === "notSent") return true;
  return attempt.kind === "sent" && attempt.status === "reverted";
}
