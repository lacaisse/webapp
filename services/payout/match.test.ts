// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  assignPlaceMints,
  matchPayerTransfer,
  utcDay,
  type MatchTransfer,
} from "./match";

const order = { total: "12.50", completedAt: "2026-07-05T14:30:00Z" };

function out(overrides: Partial<MatchTransfer>): MatchTransfer {
  return {
    hash: "0xabc",
    amount: "12.50",
    date: "2026-07-05T09:00:00Z",
    direction: "out",
    ...overrides,
  };
}

describe("utcDay", () => {
  it("returns the UTC calendar day", () => {
    expect(utcDay("2026-07-05T14:30:00Z")).toBe("2026-07-05");
    // Late-UTC-evening in a positive offset still resolves to the UTC day.
    expect(utcDay("2026-07-05T23:30:00+02:00")).toBe("2026-07-05");
  });

  it("returns null for missing / unparseable input", () => {
    expect(utcDay(null)).toBeNull();
    expect(utcDay("not-a-date")).toBeNull();
  });
});

describe("matchPayerTransfer", () => {
  it("fixes on a single exact same-day outgoing transfer", () => {
    const res = matchPayerTransfer(order, [out({ hash: "0xdead" })]);
    expect(res).toEqual({ status: "fixed", txHash: "0xdead" });
  });

  it("tolerates cent-level formatting differences", () => {
    const res = matchPayerTransfer(order, [out({ amount: "12.5" })]);
    expect(res.status).toBe("fixed");
  });

  it("ignores incoming transfers", () => {
    const res = matchPayerTransfer(order, [out({ direction: "in" })]);
    expect(res.status).toBe("nomatch");
  });

  it("ignores transfers on a different calendar day", () => {
    const res = matchPayerTransfer(order, [
      out({ date: "2026-07-04T23:59:00Z" }),
    ]);
    expect(res.status).toBe("nomatch");
  });

  it("ignores transfers with a different amount", () => {
    const res = matchPayerTransfer(order, [out({ amount: "12.49" })]);
    expect(res.status).toBe("nomatch");
  });

  it("skips transfers with an unknown timestamp", () => {
    const res = matchPayerTransfer(order, [out({ date: null })]);
    expect(res.status).toBe("nomatch");
  });

  it("is ambiguous when two distinct hashes match", () => {
    const res = matchPayerTransfer(order, [
      out({ hash: "0x1" }),
      out({ hash: "0x2" }),
    ]);
    expect(res.status).toBe("ambiguous");
  });

  it("collapses duplicate rows of the same hash to a single fix", () => {
    const res = matchPayerTransfer(order, [
      out({ hash: "0xsame" }),
      out({ hash: "0xsame" }),
    ]);
    expect(res).toEqual({ status: "fixed", txHash: "0xsame" });
  });

  it("does not match when the order has no completion date", () => {
    const res = matchPayerTransfer(
      { total: "12.50", completedAt: null },
      [out({})],
    );
    expect(res.status).toBe("nomatch");
  });
});

function mint(overrides: Partial<MatchTransfer>): MatchTransfer {
  return {
    hash: "0xmint",
    amount: "10.00",
    date: "2026-06-30T20:56:40Z",
    direction: "in",
    ...overrides,
  };
}

function pmOrder(o: {
  orderId: number;
  net: string;
  createdAt?: string | null;
  completedAt?: string | null;
}) {
  return {
    orderId: o.orderId,
    net: o.net,
    createdAt: o.createdAt ?? null,
    completedAt: o.completedAt ?? null,
  };
}

describe("assignPlaceMints", () => {
  it("matches an order to a same-amount mint on the same day", () => {
    const res = assignPlaceMints(
      [pmOrder({ orderId: 1, net: "10.00", createdAt: "2026-06-30T20:56:39Z" })],
      [mint({ hash: "0xaaa" })],
    );
    expect(res.matched).toEqual([{ orderId: 1, txHash: "0xaaa" }]);
    expect(res.unmatched).toEqual([]);
  });

  it("matches even when created and block times are hours apart, same day", () => {
    const res = assignPlaceMints(
      [pmOrder({ orderId: 1, net: "10.00", createdAt: "2026-06-30T08:00:00Z" })],
      [mint({ hash: "0xlate", date: "2026-06-30T22:30:00Z" })],
    );
    expect(res.matched).toEqual([{ orderId: 1, txHash: "0xlate" }]);
  });

  it("falls back to completedAt when createdAt is null", () => {
    const res = assignPlaceMints(
      [
        pmOrder({
          orderId: 1,
          net: "10.00",
          createdAt: null,
          completedAt: "2026-06-30T20:56:39Z",
        }),
      ],
      [mint({ hash: "0xcc" })],
    );
    expect(res.matched).toEqual([{ orderId: 1, txHash: "0xcc" }]);
  });

  it("consumes each transfer once — two equal orders get two distinct mints", () => {
    const res = assignPlaceMints(
      [
        pmOrder({ orderId: 1, net: "10.00", createdAt: "2026-06-30T20:56:00Z" }),
        pmOrder({ orderId: 2, net: "10.00", createdAt: "2026-06-30T21:03:00Z" }),
      ],
      [
        mint({ hash: "0xa", date: "2026-06-30T20:56:10Z" }),
        mint({ hash: "0xb", date: "2026-06-30T21:03:05Z" }),
      ],
    );
    expect(res.matched).toEqual([
      { orderId: 1, txHash: "0xa" },
      { orderId: 2, txHash: "0xb" },
    ]);
  });

  it("picks the nearest same-day transfer in time as a tiebreak", () => {
    const res = assignPlaceMints(
      [pmOrder({ orderId: 1, net: "10.00", createdAt: "2026-06-30T20:56:00Z" })],
      [
        mint({ hash: "0xfar", date: "2026-06-30T21:10:00Z" }),
        mint({ hash: "0xnear", date: "2026-06-30T20:57:00Z" }),
      ],
    );
    expect(res.matched).toEqual([{ orderId: 1, txHash: "0xnear" }]);
  });

  it("leaves an order unmatched when the pool is exhausted", () => {
    const res = assignPlaceMints(
      [
        pmOrder({ orderId: 1, net: "10.00", createdAt: "2026-06-30T20:56:00Z" }),
        pmOrder({ orderId: 2, net: "10.00", createdAt: "2026-06-30T20:56:30Z" }),
      ],
      [mint({ hash: "0xonly" })],
    );
    expect(res.matched).toEqual([{ orderId: 1, txHash: "0xonly" }]);
    expect(res.unmatched).toEqual([2]);
  });

  it("does not match a transfer on a different calendar day", () => {
    const res = assignPlaceMints(
      [pmOrder({ orderId: 1, net: "10.00", createdAt: "2026-06-30T23:59:00Z" })],
      [mint({ date: "2026-07-01T00:05:00Z" })],
    );
    expect(res.unmatched).toEqual([1]);
  });

  it("ignores outgoing transfers and wrong amounts", () => {
    const res = assignPlaceMints(
      [pmOrder({ orderId: 1, net: "10.00", createdAt: "2026-06-30T20:56:00Z" })],
      [mint({ direction: "out" }), mint({ amount: "9.99" })],
    );
    expect(res.unmatched).toEqual([1]);
  });

  it("tolerates cent-level amount differences", () => {
    const res = assignPlaceMints(
      [pmOrder({ orderId: 1, net: "10.00", createdAt: "2026-06-30T20:56:00Z" })],
      [mint({ hash: "0xz", amount: "10" })],
    );
    expect(res.matched).toEqual([{ orderId: 1, txHash: "0xz" }]);
  });

  it("skips orders with no created or completed date", () => {
    const res = assignPlaceMints(
      [pmOrder({ orderId: 1, net: "10.00", createdAt: null, completedAt: null })],
      [mint({})],
    );
    expect(res.unmatched).toEqual([1]);
    expect(res.matched).toEqual([]);
  });
});
