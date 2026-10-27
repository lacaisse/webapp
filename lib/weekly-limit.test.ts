// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  formatEuroInput,
  isValidWeeklyLimitCents,
  MAX_WEEKLY_LIMIT_CENTS,
  parseEuroInput,
} from "./weekly-limit";

describe("parseEuroInput", () => {
  it.each([
    ["10", 1000],
    ["10,5", 1050],
    ["10.5", 1050],
    ["10,00", 1000],
    ["10.05", 1005],
    ["10,", 1000],
    [" 7 ", 700],
    ["€10", 1000],
    ["10 €", 1000],
    ["0", 0],
    ["10000", MAX_WEEKLY_LIMIT_CENTS],
  ])("parses %j → %d cents", (raw, cents) => {
    expect(parseEuroInput(raw)).toEqual({ ok: true, cents });
  });

  it.each([[""], ["   "]])("reads %j as no limit", (raw) => {
    expect(parseEuroInput(raw)).toEqual({ ok: true, cents: null });
  });

  it.each([["abc"], ["10,505"], ["1.000,00"], ["10e2"], ["10-"], ["--1"]])(
    "rejects %j as invalid",
    (raw) => {
      expect(parseEuroInput(raw)).toEqual({ ok: false, error: "invalid" });
    },
  );

  it.each([["-1"], ["-0,50"]])("rejects %j as negative", (raw) => {
    expect(parseEuroInput(raw)).toEqual({ ok: false, error: "negative" });
  });

  it("rejects above the cap", () => {
    expect(parseEuroInput("10000,01")).toEqual({ ok: false, error: "tooLarge" });
  });
});

describe("formatEuroInput", () => {
  it.each([
    [null, ",", ""],
    [0, ",", ""],
    [1000, ",", "10"],
    [1050, ",", "10,50"],
    [1005, ".", "10.05"],
  ] as const)("formats %j (%s) → %j", (cents, sep, out) => {
    expect(formatEuroInput(cents, sep)).toBe(out);
  });

  it("round-trips through parseEuroInput", () => {
    for (const cents of [1, 99, 100, 1050, 123456]) {
      expect(parseEuroInput(formatEuroInput(cents))).toEqual({ ok: true, cents });
    }
  });
});

describe("isValidWeeklyLimitCents", () => {
  it.each([null, 0, 1000, MAX_WEEKLY_LIMIT_CENTS])("accepts %j", (v) => {
    expect(isValidWeeklyLimitCents(v)).toBe(true);
  });
  it.each([-1, 10.5, MAX_WEEKLY_LIMIT_CENTS + 1, NaN, "1000", undefined])(
    "rejects %j",
    (v) => {
      expect(isValidWeeklyLimitCents(v)).toBe(false);
    },
  );
});

describe("parseEuroInput edge cases from review", () => {
  it("rejects a lone € and inner thousands spaces, accepts .5", () => {
    expect(parseEuroInput("€")).toEqual({ ok: false, error: "invalid" });
    expect(parseEuroInput("1 000")).toEqual({ ok: false, error: "invalid" });
    expect(parseEuroInput(".5")).toEqual({ ok: true, cents: 50 });
    expect(parseEuroInput("10,")).toEqual({ ok: true, cents: 1000 });
    expect(parseEuroInput("   ")).toEqual({ ok: true, cents: null });
  });
});
