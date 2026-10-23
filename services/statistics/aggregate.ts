// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure aggregation helpers for the Statistics page: cents math, local-month
// bucketing, payout window filtering and the merged monthly series. No I/O,
// so the loaders in ./data.ts stay thin and this file carries the tests.
//
// Money is summed in integer cents and only turned back into a 2-dp decimal
// string at the end. Adding floats (0.1 + 0.2 …) drifts by a cent over a few
// hundred deposits, and these totals end up next to bank statements.

import type { Payout } from "@/services/citizenpay/types";

export type MonthTotal = { month: string; total: string }; // "YYYY-MM"

export type ContributionStats = {
  total: string;
  depositCount: number;
  memberCount: number;
  months: MonthTotal[];
};

export type PayoutTotals = {
  total: string;
  count: number;
  months: MonthTotal[];
};

export type MonthlyPoint = {
  month: string; // "YYYY-MM"
  contributions: string;
  spent: string;
};

// A Prisma Decimal, a decimal string or a number → integer cents. Decimal is
// read through `toString()` so nothing depends on its `valueOf` shape.
export function toCents(value: string | number | { toString(): string }): number {
  const n = Number(typeof value === "number" ? value : value.toString());
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export function formatCents(cents: number): string {
  const c = Math.round(cents);
  const sign = c < 0 ? "-" : "";
  const abs = Math.abs(c);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

// `YYYY-MM` in the server's local time — the same clock
// app/(fund)/statistics/range.ts resolves its windows on, so a deposit at
// 00:30 on the 1st lands in the month the "This month" preset covers.
export function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function bucketByMonth(items: { at: Date; cents: number }[]): MonthTotal[] {
  const byMonth = new Map<string, number>();
  for (const { at, cents } of items) {
    const key = monthKey(at);
    byMonth.set(key, (byMonth.get(key) ?? 0) + cents);
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([month, cents]) => ({ month, total: formatCents(cents) }));
}

// Matched member deposits → total, deposit count, distinct members and the
// per-month totals (only months that have rows).
export function summariseContributions(
  rows: {
    amount: string | number | { toString(): string };
    occurredAt: Date;
    memberId: string | null;
  }[],
): ContributionStats {
  let cents = 0;
  const members = new Set<string>();
  const items: { at: Date; cents: number }[] = [];
  for (const row of rows) {
    const c = toCents(row.amount);
    cents += c;
    if (row.memberId) members.add(row.memberId);
    items.push({ at: row.occurredAt, cents: c });
  }
  return {
    total: formatCents(cents),
    depositCount: rows.length,
    memberCount: members.size,
    months: bucketByMonth(items),
  };
}

// Completed payouts whose `createdAt` falls in the half-open `[from, to)`
// window (null = unbounded). A payout with an unreadable timestamp is left
// out rather than guessed into a month.
export function payoutsInWindow<P extends Pick<Payout, "createdAt">>(
  payouts: P[],
  from: Date | null,
  to: Date | null,
): P[] {
  return payouts.filter((p) => {
    const at = new Date(p.createdAt).getTime();
    if (Number.isNaN(at)) return false;
    if (from && at < from.getTime()) return false;
    if (to && at >= to.getTime()) return false;
    return true;
  });
}

// Sum of `net` (what the merchant actually receives) with per-month totals
// keyed on `createdAt`. Callers filter to the window first.
export function summarisePayouts(
  payouts: Pick<Payout, "createdAt" | "net">[],
): PayoutTotals {
  let cents = 0;
  const items: { at: Date; cents: number }[] = [];
  for (const p of payouts) {
    const at = new Date(p.createdAt);
    if (Number.isNaN(at.getTime())) continue;
    const c = toCents(p.net);
    cents += c;
    items.push({ at, cents: c });
  }
  return { total: formatCents(cents), count: items.length, months: bucketByMonth(items) };
}

function nextMonth(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

// Hard stop for the gap fill below: a malformed month key must not spin the
// loop, and no fund has 100 years of history.
const MAX_MONTHS = 1200;

// The chart's series: contributions and merchant sales on one ascending month
// axis. Covers every month from the first to the last one either series has,
// with the months in between zero-filled — a time axis that skipped an idle
// month would draw March right after January and hide the gap.
//
// Contributions are bucketed on the server's local clock and CitizenPay's
// months on UTC; the two only disagree for orders in the first hours of a
// month, which is noise at this resolution.
export function mergeMonthly(
  contributions: MonthTotal[],
  spent: MonthTotal[],
): MonthlyPoint[] {
  const c = new Map(contributions.map((m) => [m.month, m.total]));
  const s = new Map(spent.map((m) => [m.month, m.total]));
  const keys = [...new Set([...c.keys(), ...s.keys()])]
    .filter((k) => /^\d{4}-\d{2}$/.test(k))
    .sort();
  if (keys.length === 0) return [];

  const last = keys[keys.length - 1];
  const out: MonthlyPoint[] = [];
  for (let k = keys[0]; out.length < MAX_MONTHS; k = nextMonth(k)) {
    out.push({
      month: k,
      contributions: c.get(k) ?? "0.00",
      spent: s.get(k) ?? "0.00",
    });
    if (k >= last) break;
  }
  return out;
}
