// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  canSendManualReminder,
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
  opts: { hasEmail?: boolean; optedOut?: boolean } = {},
) =>
  reminderInfo({
    hasEmail: opts.hasEmail ?? true,
    optedOut: opts.optedOut ?? false,
    emails,
    now: NOW,
  });

describe("manual reminder availability", () => {
  it("nothing sent yet → can send", () => {
    const r = info([]);
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
    expect(canSendManualReminder(r)).toBe(true);
    expect(remindButtonLabel(r)).toBe("send");
  });

  it("manual sent yesterday → can send again", () => {
    const r = info([auto("SENT"), manual("SENT", YESTERDAY)]);
    expect(canSendManualReminder(r)).toBe(true);
    expect(remindButtonLabel(r)).toBe("sendAgain");
    expect(r.breakdown).toEqual({ key: "autoAndNudges", count: 1 });
  });

  it("manual sent today → cannot send", () => {
    const r = info([auto("SENT"), manual("SENT", TODAY)]);
    expect(canSendManualReminder(r)).toBe(false);
  });

  it("manual failed today → can send, as a retry (with or without auto)", () => {
    for (const emails of [
      [manual("FAILED", TODAY)],
      [auto("SENT"), manual("FAILED", TODAY)],
      [manual("SENT", YESTERDAY), manual("FAILED", TODAY)],
    ]) {
      const r = info(emails);
      expect(canSendManualReminder(r)).toBe(true);
      expect(remindButtonLabel(r)).toBe("retry");
    }
  });

  it("no email or opted out → cannot send", () => {
    expect(canSendManualReminder(info([], { hasEmail: false }))).toBe(false);
    expect(canSendManualReminder(info([auto("SENT")], { optedOut: true }))).toBe(
      false,
    );
  });
});
