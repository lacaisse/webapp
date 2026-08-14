// SPDX-License-Identifier: AGPL-3.0-or-later
// No `server-only` here on purpose: this is the decision logic for a money
// path, so it's unit-tested (reconcile.test.ts) with the bundler mocked, and
// `server-only` can't be resolved under vitest. Same trade-off as
// services/onboarding/visibility.ts. The network call it delegates to lives in
// services/token/userop.ts, and the action that calls it is "use server".
import { getUserOpTx } from "@/services/token/userop";

// Manual reconciliation of a token operation against the bundler (issue #162).
//
// Why this exists: a TokenOperation reaches CONFIRMED without anyone checking
// that the tokens landed. The mint path either stamps CONFIRMED as soon as
// CitizenPay accepts the UserOp (services/allocation-periods/run.ts), or leaves
// it to the status cron — and that cron asks CitizenPay's getOperationStatus,
// which returns CONFIRMED unconditionally for any hash (live client and mock
// alike). So "CONFIRMED" has meant "CP accepted the UserOp", not "the member
// received the tokens", and a UserOp that never settles is indistinguishable
// from one that did.
//
// The bundler is the only thing that can tell them apart. The hash we store on
// submit is a *userOp* hash, not the settlement tx hash; getUserOpTx resolves
// one to the other and reports the terminal state.
//
// Why manual rather than a timeout job: a UserOp that was accepted will
// normally settle, just not always inside the submit path's 60s poll window —
// so a timeout is not evidence of failure and must not auto-fail the row.
// Re-checking later is what actually resolves it.

export type ReconcileOutcome =
  // The UserOp settled. `txHash` is the real on-chain settlement hash, which
  // should replace the stored userOp hash.
  | { kind: "settled"; txHash: string }
  // Still in flight (bundler doesn't know it yet, or hasn't broadcast). Not a
  // failure — the caller should change nothing and let the admin re-check.
  | { kind: "pending"; status: "pending" | "submitted" }
  // Terminal failure on-chain. Safe to mark FAILED, which frees the member for
  // a fresh mint.
  | { kind: "failed"; status: "reverted" | "timeout"; txHash: string | null }
  // The op carries no hash at all — it never reached the bundler. The mint
  // retry cron owns this case, not reconciliation.
  | { kind: "never-submitted" }
  // The bundler could not be reached / answered badly. Deliberately distinct
  // from "failed": we know nothing, so nothing should be written.
  | { kind: "unknown"; reason: string };

export async function reconcileOperation(args: {
  chainId: number;
  txHash: string | null;
}): Promise<ReconcileOutcome> {
  if (!args.txHash) return { kind: "never-submitted" };

  let resolution;
  try {
    resolution = await getUserOpTx(args.chainId, args.txHash);
  } catch (e) {
    // Transport failure — never downgrade this to "failed", or a flaky bundler
    // would let an admin mark a settled allocation as failed and re-mint it.
    return { kind: "unknown", reason: String(e) };
  }

  if (resolution.status === "success") {
    if (!resolution.txHash) {
      return { kind: "unknown", reason: "bundler reported success with no tx" };
    }
    return { kind: "settled", txHash: resolution.txHash };
  }
  if (resolution.status === "reverted" || resolution.status === "timeout") {
    return { kind: "failed", status: resolution.status, txHash: resolution.txHash };
  }
  return { kind: "pending", status: resolution.status };
}
