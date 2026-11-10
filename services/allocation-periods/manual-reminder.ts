// SPDX-License-Identifier: AGPL-3.0-or-later

// The manual payment reminder (PAYMENT_REMINDER_SECOND) may be sent to the same
// member several times within a period, at most once per UTC calendar day. Pure
// helpers shared by the send action (remind-actions.ts) and the period page, so
// the "one per day" rule can't drift between them.

// UTC calendar day of `at`, as YYYY-MM-DD.
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10);
}

// Midnight UTC of `at`'s day.
export function utcDayStart(at: Date): Date {
  return new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()),
  );
}

// Idempotency key of the manual reminder for (period, member) on `now`'s UTC
// day. A re-click the same day hits the same row (P2002); the next day gets a
// new one. Rows from before the per-day key (no `:day:`) stay as history.
export function manualReminderKey(
  periodId: string,
  memberId: string,
  now: Date,
): string {
  return `PAYMENT_REMINDER_SECOND:period:${periodId}:member:${memberId}:day:${utcDay(now)}`;
}

export type ManualReminderRow = {
  type: string;
  status: string;
  sentAt: Date | null;
  createdAt: Date;
};

// State of the manual reminder for today, from the member's reminder rows of
// the period (other types are ignored):
//   - sentToday: a manual reminder was SENT on today's UTC day → no action
//   - failed:    the latest manual attempt isn't SENT → "Retry"
//   - none:      no manual attempt, or the latest one was sent on an earlier day
// Based on the rows, not the key, so a legacy-key row SENT today counts too.
export type ManualReminderToday = "sentToday" | "failed" | "none";

export function manualReminderToday(
  rows: ManualReminderRow[],
  now: Date,
): ManualReminderToday {
  const manual = rows.filter((r) => r.type === "PAYMENT_REMINDER_SECOND");
  const today = utcDay(now);
  if (
    manual.some(
      (r) => r.status === "SENT" && utcDay(r.sentAt ?? r.createdAt) === today,
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
