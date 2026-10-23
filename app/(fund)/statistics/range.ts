// SPDX-License-Identifier: AGPL-3.0-or-later
// Date-range presets for the Statistics page. Plain module (no "use server" /
// "server-only") so the client filter and the server page can both import it.
//
// Deliberately a sibling of `app/(fund)/bank/range.ts` rather than a shared
// helper: the two pages want different preset lists (statistics looks back
// over months and years, the bank table over days), and the window math is
// small enough that a copy reads better than a parameterised abstraction.

export type RangePreset =
  | "all"
  | "thisMonth"
  | "lastMonth"
  | "thisYear"
  | "lastYear"
  | "custom";

export const RANGE_PRESETS: readonly RangePreset[] = [
  "all",
  "thisMonth",
  "lastMonth",
  "thisYear",
  "lastYear",
  "custom",
];

// "All time" by default: the page answers "how much has this fund moved",
// and a narrower window is the follow-up question, not the first one.
export const DEFAULT_RANGE: RangePreset = "all";

export function isRangePreset(value: string | undefined): value is RangePreset {
  return value !== undefined && (RANGE_PRESETS as readonly string[]).includes(value);
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

// Local midnight for a calendar day. The `new Date(y, m, d)` constructor
// normalises overflow/underflow (m-1, m+1, d+1 …) and lands on local midnight,
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
// `[from, to)` window. `null` on either end means "unbounded" — `all` is
// unbounded on both.
//
// Computed in the server's LOCAL time, not UTC, for the same reason as the
// bank filter: "this month" means the viewer's calendar month, and the
// month buckets on this page use the same clock (see
// services/statistics/aggregate.ts::monthKey).
export function resolveRangeWindow(
  range: RangePreset,
  from: string | undefined,
  to: string | undefined,
  now: Date = new Date(),
): { from: Date | null; to: Date | null } {
  const y = now.getFullYear();
  const m = now.getMonth();

  switch (range) {
    case "all":
      return { from: null, to: null };
    case "thisMonth":
      return { from: dayStart(y, m, 1), to: dayStart(y, m + 1, 1) };
    case "lastMonth":
      return { from: dayStart(y, m - 1, 1), to: dayStart(y, m, 1) };
    case "thisYear":
      return { from: dayStart(y, 0, 1), to: dayStart(y + 1, 0, 1) };
    case "lastYear":
      return { from: dayStart(y - 1, 0, 1), to: dayStart(y, 0, 1) };
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
