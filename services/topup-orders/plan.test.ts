// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import type { TopUpOrder } from "@/services/citizenpay/types";

import {
  MAX_TOPUP_ORDERS_PER_RUN,
  opTypeFor,
  planTopUpOrders,
  type LocalTopUpOp,
} from "./plan";

const NOW = new Date("2026-10-21T10:00:00Z");

function order(
  orderId: number,
  overrides: Partial<TopUpOrder> = {},
): TopUpOrder {
  return {
    orderId,
    serial: `S-${orderId}`,
    cardAddress: `0x${String(orderId).padStart(40, "0")}`,
    amountCents: 1250,
    token: "0xtoken",
    placeId: "p1",
    placeName: "Bar du Coin",
    // Lower id = paid earlier.
    paidAt: new Date(NOW.getTime() - 60_000 * (100 - orderId)),
    state: "pending",
    claimedAt: null,
    ...overrides,
  };
}

function op(
  topUpOrderId: number,
  status: LocalTopUpOp["status"],
  overrides: Partial<LocalTopUpOp> = {},
): LocalTopUpOp {
  return {
    id: `op-${topUpOrderId}-${status}`,
    type: "TOPUP",
    status,
    txHash: status === "CONFIRMED" ? `0xhash${topUpOrderId}` : null,
    topUpOrderId,
    ...overrides,
  };
}

describe("planTopUpOrders", () => {
  it("mints a pending order with no local op, cents scaled to the token's decimals", () => {
    const [a] = planTopUpOrders([order(1)], [], { decimals: 6, now: NOW });
    expect(a).toMatchObject({ kind: "mint", units: BigInt(12_500_000) });
  });

  it("burns a reversal_pending order", () => {
    const [a] = planTopUpOrders(
      [order(1, { state: "reversal_pending" })],
      [],
      { decimals: 2, now: NOW },
    );
    expect(a).toMatchObject({ kind: "burn", units: BigInt(1250) });
  });

  it("never mints an order whose tokens already moved: only the report is resent", () => {
    const [a] = planTopUpOrders([order(1)], [op(1, "CONFIRMED")], {
      decimals: 6,
      now: NOW,
    });
    expect(a).toEqual({
      kind: "report",
      order: expect.objectContaining({ orderId: 1 }),
      opId: "op-1-CONFIRMED",
      txHash: "0xhash1",
    });
  });

  it("retries after a FAILED attempt", () => {
    const [a] = planTopUpOrders([order(1)], [op(1, "FAILED")], {
      decimals: 6,
      now: NOW,
    });
    expect(a.kind).toBe("mint");
  });

  it("leaves an order with a PENDING op alone (in flight or needs an operator)", () => {
    const [a] = planTopUpOrders(
      [order(1)],
      [op(1, "FAILED"), op(1, "PENDING")],
      { decimals: 6, now: NOW },
    );
    expect(a).toMatchObject({ kind: "skip", reason: "in_flight" });
  });

  it("keys idempotency by order id AND op type: a mint does not block the reversal", () => {
    const [a] = planTopUpOrders(
      [order(1, { state: "reversal_pending" })],
      [op(1, "CONFIRMED", { type: "TOPUP" })],
      { decimals: 6, now: NOW },
    );
    expect(a.kind).toBe("burn");
    const [b] = planTopUpOrders(
      [order(1, { state: "reversal_pending" })],
      [op(1, "CONFIRMED", { type: "TOPUP_REVERSAL" })],
      { decimals: 6, now: NOW },
    );
    expect(b.kind).toBe("report");
  });

  it("ignores ops of other orders", () => {
    const [a] = planTopUpOrders([order(1)], [op(2, "PENDING"), op(3, "CONFIRMED")], {
      decimals: 6,
      now: NOW,
    });
    expect(a.kind).toBe("mint");
  });

  it("skips an order under a live claim, and takes it once the claim expired", () => {
    const live = order(1, { claimedAt: new Date(NOW.getTime() - 5 * 60_000) });
    const stale = order(2, { claimedAt: new Date(NOW.getTime() - 11 * 60_000) });
    const actions = planTopUpOrders([live, stale], [], { decimals: 6, now: NOW });
    expect(actions.map((a) => [a.order.orderId, a.kind])).toEqual([
      [1, "skip"],
      [2, "mint"],
    ]);
    expect(actions[0]).toMatchObject({ reason: "claimed" });
  });

  it("refuses an amount the token cannot represent, or a non-positive one", () => {
    const actions = planTopUpOrders(
      [order(1, { amountCents: 1255 }), order(2, { amountCents: 0 })],
      [],
      { decimals: 1, now: NOW },
    );
    expect(actions.map((a) => a.kind)).toEqual(["skip", "skip"]);
    expect(actions.map((a) => (a as { reason: string }).reason)).toEqual([
      "amount_invalid",
      "amount_invalid",
    ]);
  });

  it("drains oldest payment first and bounds a run", () => {
    const orders = Array.from({ length: MAX_TOPUP_ORDERS_PER_RUN + 3 }, (_, i) =>
      order(i + 1),
    ).reverse();
    const actions = planTopUpOrders(orders, [], { decimals: 6, now: NOW });
    // Handed over newest-first; the plan starts with the oldest payment.
    expect(actions[0].order.orderId).toBe(1);
    expect(actions.filter((a) => a.kind === "mint")).toHaveLength(
      MAX_TOPUP_ORDERS_PER_RUN,
    );
    expect(
      actions.filter((a) => a.kind === "skip" && a.reason === "bounded"),
    ).toHaveLength(3);
  });

  it("a report counts against the budget, a skip does not", () => {
    const actions = planTopUpOrders(
      [order(1), order(2), order(3, { claimedAt: NOW })],
      [op(1, "CONFIRMED")],
      { decimals: 6, limit: 1, now: NOW },
    );
    expect(actions.map((a) => a.kind)).toEqual(["report", "skip", "skip"]);
  });
});

describe("opTypeFor", () => {
  it("maps CP states to local op types", () => {
    expect(opTypeFor("pending")).toBe("TOPUP");
    expect(opTypeFor("reversal_pending")).toBe("TOPUP_REVERSAL");
  });
});
