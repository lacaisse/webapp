// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { matchPayerTransfer, utcDay, type MatchTransfer } from "./match";

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
