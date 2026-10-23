// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  formatCents,
  mergeMonthly,
  monthKey,
  summariseContributions,
  summariseTransfers,
  toCents,
  windowMonths,
} from "./aggregate";

// Row timestamps are UTC (monthKey's clock); window edges are local
// midnights, as app/(fund)/statistics/range.ts builds them. Both are built
// explicitly so the tests pass in any TZ.
const utc = (y: number, m: number, d: number, h = 12) =>
  new Date(Date.UTC(y, m - 1, d, h));
const local = (y: number, m: number, d: number) => new Date(y, m - 1, d);

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
      occurredAt: utc(2026, 1, 1),
    }));
    // 0.1 + 0.1 + 0.1 === 0.30000000000000004 in floats.
    expect(summariseTransfers(rows).total).toBe("0.30");
  });
});

describe("monthKey", () => {
  it("is the UTC YYYY-MM", () => {
    expect(monthKey(utc(2026, 1, 31, 23))).toBe("2026-01");
    expect(monthKey(utc(2026, 12, 1, 0))).toBe("2026-12");
    // 23:30 on 30 Sep UTC is 1 Oct in Brussels, but September in UTC.
    expect(monthKey(new Date("2026-09-30T23:30:00Z"))).toBe("2026-09");
  });
});

describe("summariseTransfers", () => {
  it("totals, counts rows and buckets by UTC month", () => {
    expect(
      summariseTransfers([
        { amount: "120.00", occurredAt: utc(2026, 3, 2) },
        { amount: "80.10", occurredAt: utc(2026, 1, 10) },
        { amount: "19.90", occurredAt: utc(2026, 1, 20) },
      ]),
    ).toEqual({
      total: "220.00",
      count: 3,
      months: [
        { month: "2026-01", total: "100.00" },
        { month: "2026-03", total: "120.00" },
      ],
    });
  });

  it("is all zeros with no rows", () => {
    expect(summariseTransfers([])).toEqual({ total: "0.00", count: 0, months: [] });
  });
});

describe("summariseContributions", () => {
  it("counts every deposit, matched or not, and how many are unmatched", () => {
    const stats = summariseContributions([
      { amount: "20.00", occurredAt: utc(2026, 3, 2), memberId: "a" },
      { amount: "15.50", occurredAt: utc(2026, 1, 10), memberId: null },
      { amount: "4.50", occurredAt: utc(2026, 1, 20), memberId: "a" },
    ]);
    expect(stats).toEqual({
      total: "40.00",
      count: 3,
      unmatchedCount: 1,
      months: [
        { month: "2026-01", total: "20.00" },
        { month: "2026-03", total: "20.00" },
      ],
    });
  });
});

describe("windowMonths", () => {
  it("is the first and last month of a half-open window", () => {
    expect(
      windowMonths({ from: local(2026, 1, 1), to: local(2027, 1, 1) }),
    ).toEqual({ first: "2026-01", last: "2026-12" });
    expect(
      windowMonths({ from: local(2026, 3, 5), to: local(2026, 3, 6) }),
    ).toEqual({ first: "2026-03", last: "2026-03" });
  });

  it("is null on an unbounded side", () => {
    expect(windowMonths({ from: null, to: local(2026, 4, 1) })).toEqual({
      first: null,
      last: "2026-03",
    });
    expect(windowMonths({ from: null, to: null })).toEqual({
      first: null,
      last: null,
    });
  });
});

describe("mergeMonthly", () => {
  const ALL = { from: null, to: null };

  it("all time: unions both series over the data's extent, zero-filled", () => {
    expect(
      mergeMonthly(
        [
          { month: "2026-03", total: "30.00" },
          { month: "2025-12", total: "10.00" },
        ],
        [{ month: "2026-01", total: "5.00" }],
        ALL,
      ),
    ).toEqual([
      { month: "2025-12", contributions: "10.00", spent: "0.00" },
      { month: "2026-01", contributions: "0.00", spent: "5.00" },
      { month: "2026-02", contributions: "0.00", spent: "0.00" },
      { month: "2026-03", contributions: "30.00", spent: "0.00" },
    ]);
  });

  it("all time with no data is empty", () => {
    expect(mergeMonthly([], [], ALL)).toEqual([]);
  });

  it("a bounded window spans exactly its months, even without data", () => {
    const year = { from: local(2026, 1, 1), to: local(2027, 1, 1) };
    const out = mergeMonthly([{ month: "2026-03", total: "1.00" }], [], year);
    expect(out.map((p) => p.month)).toEqual([
      "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06",
      "2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12",
    ]);
    expect(mergeMonthly([], [], year)).toHaveLength(12);
  });

  it("folds UTC buckets outside the window into the nearest edge month", () => {
    // "This month" = October: a 00:30 local sale on 1 Oct that CP files
    // under September (UTC), and a late 31 Oct deposit filed under November.
    const october = { from: local(2026, 10, 1), to: local(2026, 11, 1) };
    const out = mergeMonthly(
      [
        { month: "2026-10", total: "10.00" },
        { month: "2026-11", total: "0.10" },
      ],
      [
        { month: "2026-09", total: "2.50" },
        { month: "2026-10", total: "7.00" },
      ],
      october,
    );
    expect(out).toEqual([
      { month: "2026-10", contributions: "10.10", spent: "9.50" },
    ]);
  });

  it("a half-open window spans from its bounded edge to the data", () => {
    const sinceMarch = { from: local(2026, 3, 1), to: null };
    expect(
      mergeMonthly([{ month: "2026-05", total: "1.00" }], [], sinceMarch).map(
        (p) => p.month,
      ),
    ).toEqual(["2026-03", "2026-04", "2026-05"]);

    const untilMarch = { from: null, to: local(2026, 4, 1) };
    expect(
      mergeMonthly([{ month: "2026-01", total: "1.00" }], [], untilMarch).map(
        (p) => p.month,
      ),
    ).toEqual(["2026-01", "2026-02", "2026-03"]);
  });

  it("keeps signed totals (refunds can make a month negative)", () => {
    const march = { from: local(2026, 3, 1), to: local(2026, 4, 1) };
    expect(
      mergeMonthly([], [{ month: "2026-03", total: "-4.50" }], march),
    ).toEqual([{ month: "2026-03", contributions: "0.00", spent: "-4.50" }]);
  });
});
