// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  FALLBACK_TIME_ZONE,
  manualReminderKey,
  manualReminderToday,
  reminderDay,
  reminderDayStart,
  resolveTimeZone,
} from "./manual-reminder";

const TZ = "Europe/Brussels";
// Winter (CET, UTC+1) and summer (CEST, UTC+2) instants.
const NOW = new Date("2026-11-10T12:00:00Z");
const TODAY = new Date("2026-11-10T08:00:00Z");
const YESTERDAY = new Date("2026-11-09T18:00:00Z");

const row = (
  type: "PAYMENT_REMINDER_FIRST" | "PAYMENT_REMINDER_SECOND",
  status: "SENT" | "FAILED" | "QUEUED",
  at: Date,
) => ({
  type,
  status,
  sentAt: status === "SENT" ? at : null,
  createdAt: at,
});

describe("reminderDay", () => {
  it("winter: 23:30 UTC is already the next Brussels day (00:30 CET)", () => {
    expect(reminderDay(new Date("2026-11-10T22:30:00Z"), TZ)).toBe(
      "2026-11-10",
    ); // 23:30 local
    expect(reminderDay(new Date("2026-11-10T23:30:00Z"), TZ)).toBe(
      "2026-11-11",
    ); // 00:30 local
  });

  it("summer: 22:30 UTC is already the next Brussels day (00:30 CEST)", () => {
    expect(reminderDay(new Date("2026-07-15T21:30:00Z"), TZ)).toBe(
      "2026-07-15",
    ); // 23:30 local
    expect(reminderDay(new Date("2026-07-15T22:30:00Z"), TZ)).toBe(
      "2026-07-16",
    ); // 00:30 local
  });

  it("falls back to Europe/Brussels for an unknown zone", () => {
    expect(resolveTimeZone("Not/AZone")).toBe(FALLBACK_TIME_ZONE);
    expect(resolveTimeZone("")).toBe(FALLBACK_TIME_ZONE);
    expect(resolveTimeZone("America/New_York")).toBe("America/New_York");
    expect(reminderDay(new Date("2026-11-10T23:30:00Z"), "Not/AZone")).toBe(
      "2026-11-11",
    );
  });
});

describe("reminderDayStart", () => {
  it("is local midnight in winter (23:00 UTC the day before)", () => {
    expect(reminderDayStart(NOW, TZ).toISOString()).toBe(
      "2026-11-09T23:00:00.000Z",
    );
    // 00:30 local is already the next day.
    expect(
      reminderDayStart(new Date("2026-11-10T23:30:00Z"), TZ).toISOString(),
    ).toBe("2026-11-10T23:00:00.000Z");
  });

  it("is local midnight in summer (22:00 UTC the day before)", () => {
    expect(
      reminderDayStart(new Date("2026-07-15T12:00:00Z"), TZ).toISOString(),
    ).toBe("2026-07-14T22:00:00.000Z");
    expect(
      reminderDayStart(new Date("2026-07-15T22:30:00Z"), TZ).toISOString(),
    ).toBe("2026-07-15T22:00:00.000Z");
  });

  it("handles the DST switch days", () => {
    // 2026-03-29: clocks go 02:00 → 03:00; the day still starts at 00:00 CET.
    expect(
      reminderDayStart(new Date("2026-03-29T20:00:00Z"), TZ).toISOString(),
    ).toBe("2026-03-28T23:00:00.000Z");
    // 2026-10-25: clocks go 03:00 → 02:00; the day starts at 00:00 CEST.
    expect(
      reminderDayStart(new Date("2026-10-25T20:00:00Z"), TZ).toISOString(),
    ).toBe("2026-10-24T22:00:00.000Z");
  });
});

describe("manualReminderKey", () => {
  it("carries period, member and the local day", () => {
    expect(manualReminderKey("p1", "m1", NOW, TZ)).toBe(
      "PAYMENT_REMINDER_SECOND:period:p1:member:m1:day:2026-11-10",
    );
  });

  it("is the same on either side of UTC midnight within one Brussels day", () => {
    const beforeUtcMidnight = new Date("2026-11-10T23:30:00Z"); // 00:30 11 Nov
    const afterUtcMidnight = new Date("2026-11-11T00:30:00Z"); // 01:30 11 Nov
    expect(manualReminderKey("p1", "m1", beforeUtcMidnight, TZ)).toBe(
      manualReminderKey("p1", "m1", afterUtcMidnight, TZ),
    );
  });

  it("changes with the local day", () => {
    expect(manualReminderKey("p1", "m1", YESTERDAY, TZ)).not.toBe(
      manualReminderKey("p1", "m1", NOW, TZ),
    );
  });
});

describe("manualReminderToday", () => {
  it("is none without manual rows (automatic one ignored)", () => {
    expect(manualReminderToday([], NOW, TZ)).toBe("none");
    expect(
      manualReminderToday(
        [row("PAYMENT_REMINDER_FIRST", "SENT", TODAY)],
        NOW,
        TZ,
      ),
    ).toBe("none");
  });

  it("is sentToday once a manual reminder was sent today", () => {
    expect(
      manualReminderToday(
        [row("PAYMENT_REMINDER_SECOND", "SENT", TODAY)],
        NOW,
        TZ,
      ),
    ).toBe("sentToday");
  });

  it("is sentToday across UTC midnight within one Brussels day", () => {
    const sentAt = new Date("2026-11-10T23:30:00Z"); // 00:30 11 Nov local
    const now = new Date("2026-11-11T00:30:00Z"); // 01:30 11 Nov local
    expect(
      manualReminderToday(
        [row("PAYMENT_REMINDER_SECOND", "SENT", sentAt)],
        now,
        TZ,
      ),
    ).toBe("sentToday");
  });

  it("is none when the last manual reminder was sent on an earlier day", () => {
    expect(
      manualReminderToday(
        [row("PAYMENT_REMINDER_SECOND", "SENT", YESTERDAY)],
        NOW,
        TZ,
      ),
    ).toBe("none");
    // 23:30 local on the 10th vs 00:30 local on the 11th: different days.
    expect(
      manualReminderToday(
        [
          row(
            "PAYMENT_REMINDER_SECOND",
            "SENT",
            new Date("2026-11-10T22:30:00Z"),
          ),
        ],
        new Date("2026-11-10T23:30:00Z"),
        TZ,
      ),
    ).toBe("none");
  });

  it("is failed when the latest manual attempt didn't go out", () => {
    expect(
      manualReminderToday(
        [
          row("PAYMENT_REMINDER_SECOND", "SENT", YESTERDAY),
          row("PAYMENT_REMINDER_SECOND", "FAILED", TODAY),
        ],
        NOW,
        TZ,
      ),
    ).toBe("failed");
  });

  it("falls back to createdAt for a SENT row without sentAt", () => {
    expect(
      manualReminderToday(
        [
          {
            type: "PAYMENT_REMINDER_SECOND",
            status: "SENT",
            sentAt: null,
            createdAt: TODAY,
          },
        ],
        NOW,
        TZ,
      ),
    ).toBe("sentToday");
  });
});
