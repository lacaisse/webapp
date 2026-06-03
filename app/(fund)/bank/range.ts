// SPDX-License-Identifier: AGPL-3.0-or-later
// Date-range presets for the Bank transactions filter. Plain module (no
// "use server" / "server-only") so the client filter and the server table can
// both import it.

export type RangePreset =
  | "today"
  | "last7"
  | "last30"
  | "thisMonth"
  | "lastMonth"
  | "custom";

export const RANGE_PRESETS: readonly RangePreset[] = [
  "today",
  "last7",
  "last30",
  "thisMonth",
  "lastMonth",
  "custom",
];

export const DEFAULT_RANGE: RangePreset = "last30";

export function isRangePreset(value: string | undefined): value is RangePreset {
  return value !== undefined && (RANGE_PRESETS as readonly string[]).includes(value);
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Local midnight for a calendar day. The `new Date(y, m, d)` constructor
// normalises overflow/underflow (d-6, d+1, m+1 …) and lands on local midnight,
// which keeps the math DST-safe — every boundary is an explicit local midnight
// rather than a fixed millisecond offset that could drift across a DST change.
function dayStart(year: number, monthIndex: number, day: number): Date {
  return new Date(year, monthIndex, day);
}

// Parse a `YYYY-MM-DD` string as local midnight, or null if absent/malformed.
function parseDay(value: string | undefined): Date | null {
  if (!value || !DAY_RE.test(value)) return null;
  const [y, m, d] = value.split("-").map(Number);
  const dt = dayStart(y, m - 1, d);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

// Resolve a preset (+ optional custom `from`/`to` days) to a half-open
// `[from, to)` window. `null` on either end means "unbounded".
//
// Computed in the server's LOCAL time, not UTC: "today"/"this month" mean the
// viewer's calendar day/month, and CitizenPay's timestamps carry a local
// offset — a UTC window would clip the night-edge of each day and drop
// transactions the user considers "today". (Vercel runs in UTC; set the
// deployment's TZ to the fund region so prod matches the data's offset.)
export function resolveRangeWindow(
  range: RangePreset,
  from: string | undefined,
  to: string | undefined,
  now: Date = new Date(),
): { from: Date | null; to: Date | null } {
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();

  switch (range) {
    case "today":
      return { from: dayStart(y, m, d), to: dayStart(y, m, d + 1) };
    case "last7":
      // Today plus the preceding 6 days = a 7-day window ending tonight.
      return { from: dayStart(y, m, d - 6), to: dayStart(y, m, d + 1) };
    case "last30":
      // Today plus the preceding 29 days = a 30-day window ending tonight.
      return { from: dayStart(y, m, d - 29), to: dayStart(y, m, d + 1) };
    case "thisMonth":
      return { from: dayStart(y, m, 1), to: dayStart(y, m + 1, 1) };
    case "lastMonth":
      return { from: dayStart(y, m - 1, 1), to: dayStart(y, m, 1) };
    case "custom": {
      const start = parseDay(from);
      const end = parseDay(to);
      // `to` is an inclusive day → advance to the next midnight (exclusive).
      return {
        from: start,
        to: end ? dayStart(end.getFullYear(), end.getMonth(), end.getDate() + 1) : null,
      };
    }
  }
}
