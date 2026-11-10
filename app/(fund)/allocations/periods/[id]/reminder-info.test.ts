// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  canSendManualReminder,
  reminderBadgeVariant,
  reminderInfo,
  remindButtonLabel,
  type ReminderEmail,
} from "./reminder-info";

const NOW = new Date("2026-11-10T12:00:00Z");
const TODAY = new Date("2026-11-10T08:00:00Z");
const YESTERDAY = new Date("2026-11-09T18:00:00Z");
const FIRST_OF_MONTH = new Date("2026-11-01T06:00:00Z");

const auto = (status: string, at = FIRST_OF_MONTH): ReminderEmail => ({
  type: "PAYMENT_REMINDER_FIRST",
  status,
  sentAt: status === "SENT" ? at : null,
  createdAt: at,
});
const manual = (status: string, at: Date): ReminderEmail => ({
  type: "PAYMENT_REMINDER_SECOND",
  status,
  sentAt: status === "SENT" ? at : null,
  createdAt: at,
});

const info = (
  emails: ReminderEmail[],
  opts: { hasEmail?: boolean; optedOut?: boolean; now?: Date } = {},
) =>
  reminderInfo({
    hasEmail: opts.hasEmail ?? true,
    optedOut: opts.optedOut ?? false,
    emails,
    now: opts.now ?? NOW,
    timeZone: "Europe/Brussels",
  });

describe("manual reminder availability", () => {
  it("nothing sent yet → can send", () => {
    const r = info([]);
    expect(r.state).toBe("notSent");
    expect(canSendManualReminder(r)).toBe(true);
    expect(remindButtonLabel(r)).toBe("send");
  });

  it("automatic reminder sent only → can send, not a retry", () => {
    const r = info([auto("SENT")]);
    expect(r.state).toBe("sent");
    expect(canSendManualReminder(r)).toBe(true);
    expect(remindButtonLabel(r)).toBe("send");
  });

  it("only the automatic attempt failed → can send, not a retry", () => {
    const r = info([auto("FAILED")]);
    expect(r.state).toBe("failed");
    expect(canSendManualReminder(r)).toBe(true);
    expect(remindButtonLabel(r)).toBe("send");
  });

  it("manual sent yesterday → can send again", () => {
    const r = info([auto("SENT"), manual("SENT", YESTERDAY)]);
    expect(r.state).toBe("sent");
    expect(canSendManualReminder(r)).toBe(true);
    expect(remindButtonLabel(r)).toBe("sendAgain");
    expect(r.breakdown).toEqual({ key: "autoAndNudges", count: 1 });
  });

  it("manual sent today → cannot send", () => {
    const r = info([auto("SENT"), manual("SENT", TODAY)]);
    expect(r.state).toBe("sent");
    expect(r.sentCount).toBe(2);
    expect(canSendManualReminder(r)).toBe(false);
  });

  it("manual sent at 00:30 Brussels, checked at 01:30 → same day, cannot send", () => {
    const r = info([manual("SENT", new Date("2026-11-10T23:30:00Z"))], {
      now: new Date("2026-11-11T00:30:00Z"),
    });
    expect(canSendManualReminder(r)).toBe(false);
  });

  it("manual failed → retry, and the badge says failed despite earlier sends", () => {
    for (const emails of [
      [manual("FAILED", TODAY)],
      [auto("SENT"), manual("FAILED", TODAY)],
      [manual("SENT", YESTERDAY), manual("FAILED", TODAY)],
    ]) {
      const r = info(emails);
      expect(canSendManualReminder(r)).toBe(true);
      expect(remindButtonLabel(r)).toBe("retry");
      expect(r.state).toBe("failed");
      expect(reminderBadgeVariant(r.state)).toBe("destructive");
    }
  });

  it("failed nudge keeps the sent history on the subline", () => {
    const r = info([auto("SENT"), manual("FAILED", TODAY)]);
    expect(r.sentCount).toBe(1);
    expect(r.lastSentAt).toEqual(FIRST_OF_MONTH);
    expect(r.breakdown).toEqual({ key: "auto", count: 0 });
  });

  it("no email or opted out → cannot send, and wins over a failed nudge", () => {
    expect(canSendManualReminder(info([], { hasEmail: false }))).toBe(false);
    const optedOut = info([auto("SENT"), manual("FAILED", TODAY)], {
      optedOut: true,
    });
    expect(optedOut.state).toBe("optedOut");
    expect(canSendManualReminder(optedOut)).toBe(false);
    const noEmail = info([manual("FAILED", TODAY)], { hasEmail: false });
    expect(noEmail.state).toBe("noEmail");
  });
});
