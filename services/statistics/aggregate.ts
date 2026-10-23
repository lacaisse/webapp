// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure aggregation helpers for the Statistics page: cents math, UTC-month
// bucketing of bank rows and the merged monthly series. No I/O, so the
// loaders in ./data.ts stay thin and this file carries the tests.
//
// Money is summed in integer cents and only turned back into a 2-dp decimal
// string at the end. Adding floats (0.1 + 0.2 …) drifts by a cent over a few
// hundred deposits, and these totals end up next to bank statements.

export type MonthTotal = { month: string; total: string }; // "YYYY-MM"

// A set of bank rows (one direction) over the window.
export type TransferTotals = {
  total: string;
  count: number;
  months: MonthTotal[];
};

// Contributions as the dashboard defines them: every INCOMING bank row,
// matched to a member or not. `unmatchedCount` is the part still waiting for
// a member, the same split the dashboard's contributions hint shows.
export type ContributionStats = TransferTotals & { unmatchedCount: number };

export type MonthlyPoint = {
  month: string; // "YYYY-MM"
  contributions: string;
  spent: string;
};

type Amount = string | number | { toString(): string };

// A Prisma Decimal, a decimal string or a number → integer cents. Decimal is
// read through `toString()` so nothing depends on its `valueOf` shape.
export function toCents(value: Amount): number {
  const n = Number(typeof value === "number" ? value : value.toString());
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

export function formatCents(cents: number): string {
  const c = Math.round(cents);
  const sign = c < 0 ? "-" : "";
  const abs = Math.abs(c);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

// `YYYY-MM` in UTC — the same months as the dashboard's money series
// (app/(fund)/dashboard/data.ts) and as CitizenPay's per-month sales, so the
// two chart series bucket every row on one clock.
export function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
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

// Bank rows → total, row count and per-UTC-month totals (only months that
// have rows). Callers query one direction over the window first.
export function summariseTransfers(
  rows: { amount: Amount; occurredAt: Date }[],
): TransferTotals {
  let cents = 0;
  const items: { at: Date; cents: number }[] = [];
  for (const row of rows) {
    const c = toCents(row.amount);
    cents += c;
    items.push({ at: row.occurredAt, cents: c });
  }
  return {
    total: formatCents(cents),
    count: rows.length,
    months: bucketByMonth(items),
  };
}

// INCOMING bank rows → the transfer totals plus how many have no member yet.
export function summariseContributions(
  rows: { amount: Amount; occurredAt: Date; memberId: string | null }[],
): ContributionStats {
  return {
    ...summariseTransfers(rows),
    unmatchedCount: rows.filter((r) => !r.memberId).length,
  };
}

function nextMonth(key: string): string {
  const [y, m] = key.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

// The calendar month a window edge falls in, on the clock the window was
// built on: app/(fund)/statistics/range.ts resolves presets and custom days
// to the server's LOCAL midnights. Reading those edges in UTC would add a
// stray month on any server not on UTC (local 1 Oct 00:00 is 30 Sep 22:00Z in
// Brussels), so the edges keep the window's clock and the UTC buckets that
// straddle them are folded in (see mergeMonthly). In production the server
// runs on UTC and the two clocks are the same.
function localMonthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

// The first and last month a half-open `[from, to)` window covers, null on an
// unbounded side.
export function windowMonths(window: {
  from: Date | null;
  to: Date | null;
}): { first: string | null; last: string | null } {
  return {
    first: window.from ? localMonthKey(window.from) : null,
    last: window.to ? localMonthKey(new Date(window.to.getTime() - 1)) : null,
  };
}

// Hard stop for the gap fill below: a malformed month key must not spin the
// loop, and no fund has 100 years of history.
const MAX_MONTHS = 1200;

const MONTH_RE = /^\d{4}-\d{2}$/;

// The chart's series: contributions and merchant sales on one ascending month
// axis, zero-filled — a time axis that skipped an idle month would draw March
// right after January and hide the gap.
//
// A bounded window spans exactly its own months, first to last, even where
// they have no data. Any bucket outside that span is folded into the nearest
// edge month rather than dropped or drawn: it is a row that is inside the
// window but lands in the neighbouring month on UTC (e.g. a 00:30 local sale
// on the 1st, which CitizenPay files under the previous UTC month), so
// folding keeps the chart adding up to the KPI tiles. An unbounded side
// ("all time") spans the data's own extent.
export function mergeMonthly(
  contributions: MonthTotal[],
  spent: MonthTotal[],
  window: { from: Date | null; to: Date | null },
): MonthlyPoint[] {
  const valid = (ms: MonthTotal[]) => ms.filter((m) => MONTH_RE.test(m.month));
  const c = valid(contributions);
  const s = valid(spent);
  const keys = [...c, ...s].map((m) => m.month).sort();

  const { first, last } = windowMonths(window);
  let start = first ?? keys[0];
  let end = last ?? keys[keys.length - 1];
  // An unbounded side with no data to take its extent from: nothing to draw.
  if (start === undefined || end === undefined) return [];
  // One bounded side, data all beyond it: the span is just that edge month.
  if (!first && start > end) start = end;
  if (!last && end < start) end = start;
  if (start > end) return [];

  const clamp = (k: string) => (k < start ? start : k > end ? end : k);
  const sums = (ms: MonthTotal[]) => {
    const out = new Map<string, number>();
    for (const m of ms) {
      const k = clamp(m.month);
      out.set(k, (out.get(k) ?? 0) + toCents(m.total));
    }
    return out;
  };
  const cSums = sums(c);
  const sSums = sums(s);

  const out: MonthlyPoint[] = [];
  for (let k = start; out.length < MAX_MONTHS; k = nextMonth(k)) {
    out.push({
      month: k,
      contributions: formatCents(cSums.get(k) ?? 0),
      spent: formatCents(sSums.get(k) ?? 0),
    });
    if (k >= end) break;
  }
  return out;
}
