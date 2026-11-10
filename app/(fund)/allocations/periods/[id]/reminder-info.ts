// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  manualReminderToday,
  type ManualReminderRow,
  type ManualReminderToday,
} from "@/services/allocation-periods/manual-reminder";

// Per-member payment-reminder state for the Missing tab. "noEmail"/"optedOut"
// mean the member can't be reminded (no send button); the rest drive the badge
// and cover both kinds (FIRST = the monthly cron's automatic request, SECOND =
// a manual admin nudge):
//   - sent:    a SENT reminder of either kind exists for this period
//   - failed:  only FAILED/QUEUED attempts so far
//   - notSent: emailable, no reminder yet
// The button follows `manual` alone: a manual nudge can be sent once per UTC
// day, whatever was sent before (see manual-reminder.ts).
export type ReminderState =
  | "noEmail"
  | "optedOut"
  | "sent"
  | "failed"
  | "notSent";

// Widened to the generated enum types — the query already filters `type` to the
// two reminder kinds, so we only branch on the values, not the full union.
export type ReminderEmail = ManualReminderRow;

// Richer reminder info for the Missing-tab cell: the collapsed `state` (badge
// colour), today's manual-reminder state (button), how many reminders actually
// went out, when the last one was sent, and an auto/manual breakdown.
export type ReminderInfo = {
  state: ReminderState;
  manual: ManualReminderToday;
  // A manual nudge was SENT on an earlier day ("Send again").
  nudgedBefore: boolean;
  sentCount: number;
  lastSentAt: Date | null;
  // Derived purely from sent history, independent of `state` — so a member who
  // was reminded and then unsubscribed shows the "Opted out" badge AND the
  // sent-history subline. null only when nothing has actually been sent.
  breakdown: {
    key: "auto" | "autoAndNudges" | "nudgesOnly";
    count: number; // manual-nudge count (the only pluralised token)
  } | null;
};

export function reminderInfo(args: {
  hasEmail: boolean;
  optedOut: boolean;
  emails: ReminderEmail[];
  now: Date;
}): ReminderInfo {
  const sent = args.emails.filter((e) => e.status === "SENT");
  const autoSent = sent.some((e) => e.type === "PAYMENT_REMINDER_FIRST");
  const manualSentCount = sent.filter(
    (e) => e.type === "PAYMENT_REMINDER_SECOND",
  ).length;
  // Most recent successful send; fall back to createdAt on the off chance a
  // SENT row predates the sentAt column being populated.
  const lastSentAt = sent.reduce<Date | null>((latest, e) => {
    const at = e.sentAt ?? e.createdAt;
    return !latest || at > latest ? at : latest;
  }, null);

  let breakdown: ReminderInfo["breakdown"] = null;
  if (sent.length > 0) {
    if (autoSent && manualSentCount > 0) {
      breakdown = { key: "autoAndNudges", count: manualSentCount };
    } else if (autoSent) {
      breakdown = { key: "auto", count: 0 };
    } else {
      breakdown = { key: "nudgesOnly", count: manualSentCount };
    }
  }

  let state: ReminderState;
  if (!args.hasEmail) state = "noEmail";
  else if (args.optedOut) state = "optedOut";
  else if (sent.length > 0) state = "sent";
  else if (args.emails.length > 0) state = "failed";
  else state = "notSent";

  return {
    state,
    manual: manualReminderToday(args.emails, args.now),
    nudgedBefore: manualSentCount > 0,
    sentCount: sent.length,
    lastSentAt,
    breakdown,
  };
}

// Can a manual reminder be sent now: emailable, not opted out, and none SENT
// yet today (the automatic one and earlier days' nudges don't count).
export function canSendManualReminder(info: ReminderInfo): boolean {
  return (
    info.state !== "noEmail" &&
    info.state !== "optedOut" &&
    info.manual !== "sentToday"
  );
}

// Row button label: retry today's failed attempt, send again after an earlier
// nudge, or a first send.
export function remindButtonLabel(
  info: ReminderInfo,
): "retry" | "sendAgain" | "send" {
  if (info.manual === "failed") return "retry";
  if (info.nudgedBefore) return "sendAgain";
  return "send";
}

export function reminderBadgeVariant(
  state: ReminderState,
): "success" | "destructive" | "outline" {
  if (state === "sent") return "success";
  if (state === "failed") return "destructive";
  return "outline";
}
