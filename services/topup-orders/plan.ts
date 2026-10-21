// SPDX-License-Identifier: AGPL-3.0-or-later
import { centsToTokenUnits } from "@/services/card-topup/amount";
import type { TopUpOrder } from "@/services/citizenpay/types";

// Pure decision logic of the terminal top-up cron: given what Citizen Pay
// lists as waiting for the issuer and what this fund already did locally,
// decide per order whether to move tokens, only re-report a move that already
// happened, or leave it alone. No I/O, so it is unit-tested on its own; the
// claim / mint / report side effects live in run.ts.
//
// Idempotency has two layers. Citizen Pay's 10-minute claim is the lock
// between concurrent runs; the local TokenOperation keyed by order id is the
// memory across runs: an order whose userop settled (a CONFIRMED op) is never
// minted again — only its report is retried, with the userop hash — and an
// order whose op is still PENDING (a run is submitting it, or its userop is
// awaiting resolution against the bundler) is left alone rather than retried
// blind. Only a FAILED op (the bundler refused the userop, or it never
// settled) frees the order for another attempt.

export const MAX_TOPUP_ORDERS_PER_RUN = 25;

/** Citizen Pay's claim TTL; a listed `claimedAt` younger than this is live. */
export const TOPUP_CLAIM_TTL_MS = 10 * 60 * 1000;

export type TopUpOpType = "TOPUP" | "TOPUP_REVERSAL";

export type LocalTopUpOp = {
  id: string;
  type: TopUpOpType;
  status: "PENDING" | "CONFIRMED" | "FAILED";
  txHash: string | null;
  userOpHash: string | null;
  topUpOrderId: number | null;
};

export type TopUpSkipReason =
  | "in_flight" // a local op is still PENDING: being submitted, or awaiting the bundler
  | "claimed" // CP lists a live claim (ours from a failed attempt, or another runner's)
  | "amount_invalid" // not a positive amount representable in the token's decimals
  | "bounded"; // over the per-run limit — next tick

export type TopUpAction =
  | { kind: "mint"; order: TopUpOrder; units: bigint }
  | { kind: "burn"; order: TopUpOrder; units: bigint }
  | {
      // The userop settled for this order (local CONFIRMED op) but CP still
      // lists it: the credit / reverse report didn't land — resend it with the
      // hash the bundler returned (CP keys on userop hashes).
      kind: "report";
      order: TopUpOrder;
      opId: string;
      txHash: string;
    }
  | { kind: "skip"; order: TopUpOrder; reason: TopUpSkipReason };

/** The op type that settles an order in this state. */
export function opTypeFor(state: TopUpOrder["state"]): TopUpOpType {
  return state === "pending" ? "TOPUP" : "TOPUP_REVERSAL";
}

export function planTopUpOrders(
  orders: TopUpOrder[],
  localOps: LocalTopUpOp[],
  opts: { decimals: number; limit?: number; now?: Date },
): TopUpAction[] {
  const limit = opts.limit ?? MAX_TOPUP_ORDERS_PER_RUN;
  const now = opts.now ?? new Date();
  // Oldest payment first, so a backlog drains in the order members paid.
  const sorted = [...orders].sort(
    (a, b) =>
      (a.paidAt?.getTime() ?? 0) - (b.paidAt?.getTime() ?? 0) ||
      a.orderId - b.orderId,
  );

  let budget = limit;
  const actions: TopUpAction[] = [];
  for (const order of sorted) {
    const type = opTypeFor(order.state);
    const ops = localOps.filter(
      (op) => op.topUpOrderId === order.orderId && op.type === type,
    );
    const done = ops.find(
      (op) => op.status === "CONFIRMED" && (op.userOpHash || op.txHash),
    );
    const inFlight = ops.some((op) => op.status === "PENDING");

    if (inFlight) {
      actions.push({ kind: "skip", order, reason: "in_flight" });
      continue;
    }
    if (
      order.claimedAt &&
      now.getTime() - order.claimedAt.getTime() < TOPUP_CLAIM_TTL_MS
    ) {
      actions.push({ kind: "skip", order, reason: "claimed" });
      continue;
    }
    if (budget <= 0) {
      actions.push({ kind: "skip", order, reason: "bounded" });
      continue;
    }
    if (done) {
      budget -= 1;
      actions.push({
        kind: "report",
        order,
        opId: done.id,
        txHash: (done.userOpHash ?? done.txHash) as string,
      });
      continue;
    }
    let units: bigint;
    try {
      if (order.amountCents <= 0) throw new Error("non-positive");
      units = centsToTokenUnits(order.amountCents, opts.decimals);
    } catch {
      actions.push({ kind: "skip", order, reason: "amount_invalid" });
      continue;
    }
    budget -= 1;
    actions.push({
      kind: type === "TOPUP" ? "mint" : "burn",
      order,
      units,
    });
  }
  return actions;
}
