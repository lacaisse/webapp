// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  formatCents,
  mergeMonthly,
  monthKey,
  payoutsInWindow,
  summariseContributions,
  summarisePayouts,
  toCents,
} from "./aggregate";

// Local-time dates throughout, matching monthKey's local clock.
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h);

describe("cents math", () => {
  it("rounds decimal strings, numbers and Decimal-likes to integer cents", () => {
    expect(toCents("12.34")).toBe(1234);
    expect(toCents(0.1)).toBe(10);
    expect(toCents({ toString: () => "1.25" })).toBe(125);
    expect(toCents("-3.5")).toBe(-350);
    expect(toCents("not a number")).toBe(0);
  });

  it("formats cents as a 2-dp decimal string", () => {
    expect(formatCents(0)).toBe("0.00");
    expect(formatCents(5)).toBe("0.05");
    expect(formatCents(123456)).toBe("1234.56");
    expect(formatCents(-205)).toBe("-2.05");
  });

  it("does not drift where float addition would", () => {
    const rows = Array.from({ length: 3 }, () => ({
      amount: "0.10",
      occurredAt: at(2026, 1, 1),
      memberId: "m",
    }));
    // 0.1 + 0.1 + 0.1 === 0.30000000000000004 in floats.
    expect(summariseContributions(rows).total).toBe("0.30");
  });
});

describe("monthKey", () => {
  it("is the local YYYY-MM", () => {
    expect(monthKey(at(2026, 1, 31, 23))).toBe("2026-01");
    expect(monthKey(at(2026, 12, 1, 0))).toBe("2026-12");
  });
});

describe("summariseContributions", () => {
  it("totals, counts deposits and distinct members, buckets by month", () => {
    const stats = summariseContributions([
      { amount: "20.00", occurredAt: at(2026, 3, 2), memberId: "a" },
      { amount: "15.50", occurredAt: at(2026, 1, 10), memberId: "b" },
      { amount: "4.50", occurredAt: at(2026, 1, 20), memberId: "a" },
    ]);
    expect(stats).toEqual({
      total: "40.00",
      depositCount: 3,
      memberCount: 2,
      months: [
        { month: "2026-01", total: "20.00" },
        { month: "2026-03", total: "20.00" },
      ],
    });
  });

  it("is all zeros with no rows", () => {
    expect(summariseContributions([])).toEqual({
      total: "0.00",
      depositCount: 0,
      memberCount: 0,
      months: [],
    });
  });
});

describe("payouts", () => {
  const payouts = [
    { id: "1", createdAt: at(2026, 2, 28).toISOString(), net: "100.10" },
    { id: "2", createdAt: at(2026, 3, 1, 0).toISOString(), net: "50.05" },
    { id: "3", createdAt: at(2026, 4, 1, 0).toISOString(), net: "9.99" },
    { id: "4", createdAt: "garbage", net: "1.00" },
  ];

  it("keeps payouts created in the half-open window", () => {
    const kept = payoutsInWindow(payouts, at(2026, 3, 1, 0), at(2026, 4, 1, 0));
    expect(kept.map((p) => p.id)).toEqual(["2"]);
  });

  it("an unbounded window keeps every readable payout", () => {
    expect(payoutsInWindow(payouts, null, null).map((p) => p.id)).toEqual([
      "1",
      "2",
      "3",
    ]);
  });

  it("sums net in cents and buckets by created month", () => {
    expect(summarisePayouts(payouts)).toEqual({
      total: "160.14",
      count: 3,
      months: [
        { month: "2026-02", total: "100.10" },
        { month: "2026-03", total: "50.05" },
        { month: "2026-04", total: "9.99" },
      ],
    });
  });
});

describe("mergeMonthly", () => {
  it("unions both series ascending and zero-fills missing values and gaps", () => {
    expect(
      mergeMonthly(
        [
          { month: "2026-03", total: "30.00" },
          { month: "2025-12", total: "10.00" },
        ],
        [{ month: "2026-01", total: "5.00" }],
      ),
    ).toEqual([
      { month: "2025-12", contributions: "10.00", spent: "0.00" },
      { month: "2026-01", contributions: "0.00", spent: "5.00" },
      { month: "2026-02", contributions: "0.00", spent: "0.00" },
      { month: "2026-03", contributions: "30.00", spent: "0.00" },
    ]);
  });

  it("is empty when neither series has months", () => {
    expect(mergeMonthly([], [])).toEqual([]);
  });
});
