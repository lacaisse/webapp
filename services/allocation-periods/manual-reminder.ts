// SPDX-License-Identifier: AGPL-3.0-or-later

// The manual payment reminder (PAYMENT_REMINDER_SECOND) may be sent to the same
// member several times within a period, at most once per calendar day in the
// fund's own timezone (`Fund.timezone`). Pure helpers shared by the send action
// (remind-actions.ts) and the period page, so the "one per day" rule can't
// drift between them.

// `Fund.timezone`'s schema default; used when a stored value isn't a zone
// Intl knows (the settings form only checks it's non-empty).
export const FALLBACK_TIME_ZONE = "Europe/Brussels";

export function resolveTimeZone(timeZone: string | null | undefined): string {
  if (!timeZone) return FALLBACK_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return FALLBACK_TIME_ZONE;
  }
}

// Wall-clock parts of `at` in `timeZone`.
function zonedParts(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

// Offset of `timeZone` from UTC at instant `at`, in ms (Brussels: +1 h / +2 h).
function zoneOffsetMs(at: Date, timeZone: string): number {
  const p = zonedParts(at, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

// Calendar day of `at` in `timeZone`, as YYYY-MM-DD.
export function reminderDay(at: Date, timeZone: string): string {
  const p = zonedParts(at, resolveTimeZone(timeZone));
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

// The instant `at`'s day starts (00:00 local) in `timeZone`. DST-safe: the
// offset is read at the candidate instant itself, then re-checked once.
export function reminderDayStart(at: Date, timeZone: string): Date {
  const tz = resolveTimeZone(timeZone);
  const p = zonedParts(at, tz);
  const midnightAsUtc = Date.UTC(p.year, p.month - 1, p.day);
  let start = midnightAsUtc - zoneOffsetMs(new Date(midnightAsUtc), tz);
  start = midnightAsUtc - zoneOffsetMs(new Date(start), tz);
  return new Date(start);
}

// Idempotency key of the manual reminder for (period, member) on `now`'s local
// day. A re-click the same day hits the same row (P2002); the next day gets a
// new one. Rows from before the per-day key (no `:day:`) stay as history.
export function manualReminderKey(
  periodId: string,
  memberId: string,
  now: Date,
  timeZone: string,
): string {
  return `PAYMENT_REMINDER_SECOND:period:${periodId}:member:${memberId}:day:${reminderDay(now, timeZone)}`;
}

export type ManualReminderRow = {
  type: string;
  status: string;
  sentAt: Date | null;
  createdAt: Date;
};

// State of the manual reminder for today (the fund's local day), from the
// member's reminder rows of the period (other types are ignored):
//   - sentToday: a manual reminder was SENT today → no action
//   - failed:    the latest manual attempt isn't SENT → "Retry"
//   - none:      no manual attempt, or the latest one was sent on an earlier day
// Based on the rows, not the key, so a row SENT today under an older key
// format counts too.
export type ManualReminderToday = "sentToday" | "failed" | "none";

export function manualReminderToday(
  rows: ManualReminderRow[],
  now: Date,
  timeZone: string,
): ManualReminderToday {
  const manual = rows.filter((r) => r.type === "PAYMENT_REMINDER_SECOND");
  const today = reminderDay(now, timeZone);
  if (
    manual.some(
      (r) =>
        r.status === "SENT" &&
        reminderDay(r.sentAt ?? r.createdAt, timeZone) === today,
    )
  ) {
    return "sentToday";
  }
  const latest = manual.reduce<ManualReminderRow | null>(
    (acc, r) => (!acc || r.createdAt > acc.createdAt ? r : acc),
    null,
  );
  if (latest && latest.status !== "SENT") return "failed";
  return "none";
}
