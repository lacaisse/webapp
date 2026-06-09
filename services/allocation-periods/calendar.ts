// SPDX-License-Identifier: AGPL-3.0-or-later

// Calendar-month period maths for FIXED_PERIOD allocations.
//
// A period is one calendar month. `startsAt` is the 1st of the month at
// 00:00 and `label` is "YYYY-MM". `cutoffDate` is the END of the configured
// cutoff day (23:59:59.999) so a deposit made any time on the cutoff day
// still counts. The cutoff day is clamped to the month length, so a fund
// configured with day 31 always cuts off on the last day of every month.
//
// Everything here is computed in UTC — consistent with the rest of the
// allocation code (labels, the close cron's `cutoffDate <= now` check). Fund
// timezone is not applied to period boundaries today; if that's needed later
// it should be layered in one place (here) and nowhere else.

export type PeriodWindow = {
  startsAt: Date;
  cutoffDate: Date;
  label: string; // "YYYY-MM"
};

// Day-of-month config is clamped to [1, 31] defensively; callers should
// already validate, but a stored 0 / 99 shouldn't produce a nonsense date.
function normaliseCutoffDay(cutoffDay: number): number {
  if (!Number.isFinite(cutoffDay)) return 31;
  return Math.min(31, Math.max(1, Math.trunc(cutoffDay)));
}

// Last calendar day of the given UTC month (month0 is 0-indexed).
function lastDayOfMonth(year: number, month0: number): number {
  // Day 0 of the *next* month is the last day of this one.
  return new Date(Date.UTC(year, month0 + 1, 0)).getUTCDate();
}

export function monthLabel(d: Date): string {
  const year = d.getUTCFullYear();
  const month = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  return `${year}-${month}`;
}

// The period window for a specific calendar month (month0 0-indexed).
export function periodForMonth(
  year: number,
  month0: number,
  cutoffDay: number,
): PeriodWindow {
  const day = Math.min(normaliseCutoffDay(cutoffDay), lastDayOfMonth(year, month0));
  return {
    startsAt: new Date(Date.UTC(year, month0, 1, 0, 0, 0, 0)),
    cutoffDate: new Date(Date.UTC(year, month0, day, 23, 59, 59, 999)),
    label: `${year}-${(month0 + 1).toString().padStart(2, "0")}`,
  };
}

// The period for the calendar month the given instant falls in.
export function periodForDate(date: Date, cutoffDay: number): PeriodWindow {
  return periodForMonth(date.getUTCFullYear(), date.getUTCMonth(), cutoffDay);
}

// The calendar month after the given period start.
export function nextPeriodAfter(startsAt: Date, cutoffDay: number): PeriodWindow {
  const y = startsAt.getUTCFullYear();
  const m = startsAt.getUTCMonth();
  return m === 11
    ? periodForMonth(y + 1, 0, cutoffDay)
    : periodForMonth(y, m + 1, cutoffDay);
}

// The period a deposit arriving at `now` should attach to. If this month's
// cutoff has already passed, deposits roll into next month's period — standard
// cutoff semantics. This is the window `ensureOpenPeriod` get-or-creates.
export function activePeriodFor(now: Date, cutoffDay: number): PeriodWindow {
  const thisMonth = periodForDate(now, cutoffDay);
  if (now.getTime() <= thisMonth.cutoffDate.getTime()) return thisMonth;
  return nextPeriodAfter(thisMonth.startsAt, cutoffDay);
}
