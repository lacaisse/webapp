// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  manualReminderKey,
  manualReminderToday,
  utcDay,
  utcDayStart,
} from "./manual-reminder";

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

describe("utcDay / utcDayStart", () => {
  it("uses the UTC calendar day, not the local one", () => {
    expect(utcDay(new Date("2026-11-10T23:59:59Z"))).toBe("2026-11-10");
    expect(utcDay(new Date("2026-11-11T00:00:00Z"))).toBe("2026-11-11");
    expect(utcDayStart(NOW).toISOString()).toBe("2026-11-10T00:00:00.000Z");
  });
});

describe("manualReminderKey", () => {
  it("carries period, member and the UTC day", () => {
    expect(manualReminderKey("p1", "m1", NOW)).toBe(
      "PAYMENT_REMINDER_SECOND:period:p1:member:m1:day:2026-11-10",
    );
  });

  it("changes with the day, not within it", () => {
    expect(manualReminderKey("p1", "m1", TODAY)).toBe(
      manualReminderKey("p1", "m1", NOW),
    );
    expect(manualReminderKey("p1", "m1", YESTERDAY)).not.toBe(
      manualReminderKey("p1", "m1", NOW),
    );
  });
});

describe("manualReminderToday", () => {
  it("is none without manual rows (automatic one ignored)", () => {
    expect(manualReminderToday([], NOW)).toBe("none");
    expect(
      manualReminderToday([row("PAYMENT_REMINDER_FIRST", "SENT", TODAY)], NOW),
    ).toBe("none");
  });

  it("is sentToday once a manual reminder was sent today", () => {
    expect(
      manualReminderToday([row("PAYMENT_REMINDER_SECOND", "SENT", TODAY)], NOW),
    ).toBe("sentToday");
  });

  it("is none when the last manual reminder was sent on an earlier day", () => {
    expect(
      manualReminderToday(
        [row("PAYMENT_REMINDER_SECOND", "SENT", YESTERDAY)],
        NOW,
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
      ),
    ).toBe("sentToday");
  });
});
