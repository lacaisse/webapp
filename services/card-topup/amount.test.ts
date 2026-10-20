// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  centsToEuroString,
  centsToTokenUnits,
  parseTopUpAmount,
  StartCardTopUpSchema,
  TOP_UP_PRESETS_CENTS,
  validateTopUpCents,
} from "./amount";

describe("parseTopUpAmount", () => {
  it.each([
    ["5", 500],
    ["10", 1000],
    ["12.5", 1250],
    ["12,50", 1250],
    ["€ 12,05", 1205],
    [" 1 ", 100],
    ["500", 50_000],
    ["499.99", 49_999],
  ])("parses %j as %i cents", (input, cents) => {
    expect(parseTopUpAmount(input)).toEqual({ ok: true, cents });
  });

  it.each(["", "abc", "12.345", "1.000,00", "-5", "12.", ".5", "1e3", "12,5,0"])(
    "rejects %j as invalid",
    (input) => {
      expect(parseTopUpAmount(input)).toEqual({
        ok: false,
        error: "cotisation.topUp.errors.amountInvalid",
      });
    },
  );

  it("enforces the €1 minimum and €500 maximum", () => {
    expect(parseTopUpAmount("0,99")).toEqual({
      ok: false,
      error: "cotisation.topUp.errors.amountMin",
    });
    expect(parseTopUpAmount("500.01")).toEqual({
      ok: false,
      error: "cotisation.topUp.errors.amountMax",
    });
    expect(parseTopUpAmount("0")).toEqual({
      ok: false,
      error: "cotisation.topUp.errors.amountInvalid",
    });
  });

  it("accepts every preset", () => {
    for (const cents of TOP_UP_PRESETS_CENTS) {
      expect(validateTopUpCents(cents)).toEqual({ ok: true, cents });
    }
  });
});

describe("centsToTokenUnits", () => {
  it("scales euros 1:1 to a 6-decimal token", () => {
    expect(centsToTokenUnits(1250, 6)).toBe(BigInt(12_500_000));
    expect(centsToTokenUnits(100, 6)).toBe(BigInt(1_000_000));
  });

  it("handles 18 and 2 decimals", () => {
    expect(centsToTokenUnits(1, 18)).toBe(BigInt(10) ** BigInt(16));
    expect(centsToTokenUnits(1234, 2)).toBe(BigInt(1234));
  });

  it("refuses to round when the token has fewer than 2 decimals", () => {
    expect(centsToTokenUnits(1200, 0)).toBe(BigInt(12));
    expect(() => centsToTokenUnits(1250, 0)).toThrow();
  });

  it("rejects bad input", () => {
    expect(() => centsToTokenUnits(-1, 6)).toThrow();
    expect(() => centsToTokenUnits(1.5, 6)).toThrow();
  });
});

describe("centsToEuroString", () => {
  it("formats as a 2-decimal string", () => {
    expect(centsToEuroString(1250)).toBe("12.50");
    expect(centsToEuroString(5)).toBe("0.05");
    expect(centsToEuroString(50_000)).toBe("500.00");
  });
});

describe("StartCardTopUpSchema", () => {
  const base = { serial: "04516F320A1291", amountCents: 1000, bankId: "bank-1" };

  it("accepts a valid request and normalises the IBAN", () => {
    const r = StartCardTopUpSchema.safeParse({
      ...base,
      iban: "be68 5390 0754 7034",
    });
    expect(r.success && r.data.iban).toBe("BE68539007547034");
  });

  it("rejects out-of-range or fractional cents with i18n keys", () => {
    const low = StartCardTopUpSchema.safeParse({ ...base, amountCents: 99 });
    const high = StartCardTopUpSchema.safeParse({ ...base, amountCents: 50_001 });
    const frac = StartCardTopUpSchema.safeParse({ ...base, amountCents: 10.5 });
    expect(low.error?.issues[0].message).toBe("cotisation.topUp.errors.amountMin");
    expect(high.error?.issues[0].message).toBe("cotisation.topUp.errors.amountMax");
    expect(frac.error?.issues[0].message).toBe(
      "cotisation.topUp.errors.amountInvalid",
    );
  });

  it("requires a bank and a plausible IBAN", () => {
    expect(
      StartCardTopUpSchema.safeParse({ ...base, bankId: " " }).error?.issues[0]
        .message,
    ).toBe("cotisation.topUp.errors.bankRequired");
    expect(
      StartCardTopUpSchema.safeParse({ ...base, iban: "not an iban" }).error
        ?.issues[0].message,
    ).toBe("cotisation.topUp.errors.ibanInvalid");
  });
});
