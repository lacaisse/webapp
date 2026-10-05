// SPDX-License-Identifier: AGPL-3.0-or-later

// Citizen Pay refuses a FORCED release of a burn claim until the claim is this
// old (409 `burn claim is too recent`): a live burn can take a few minutes to
// reach the chain, so a younger claim may belong to an attempt still running.
// Mirrored here only to show the admin when Release becomes available — the
// api is what enforces it.
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
