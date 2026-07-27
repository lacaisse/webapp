// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  coerceBuiltinValue,
  getBuiltinField,
  isMemberBuiltinKey,
  MEMBER_BUILTIN_FIELDS,
} from "./builtin-fields";

describe("the built-in registry", () => {
  it("recognises the collectable attributes", () => {
    for (const key of [
      "phone",
      "address",
      "postalCode",
      "city",
      "iban",
      "householdAdults",
      "householdChildren",
    ]) {
      expect(isMemberBuiltinKey(key)).toBe(true);
    }
  });

  it("excludes admin-internal and auto-captured columns", () => {
    // `notes` is staff commentary and `locale` comes from the request — asking
    // an applicant for either would be wrong, not merely unnecessary.
    expect(isMemberBuiltinKey("notes")).toBe(false);
    expect(isMemberBuiltinKey("locale")).toBe(false);
  });

  it("rejects unrelated Member columns and outright nonsense", () => {
    expect(isMemberBuiltinKey("status")).toBe(false);
    expect(isMemberBuiltinKey("paymentReference")).toBe(false);
    expect(isMemberBuiltinKey("")).toBe(false);
    expect(getBuiltinField("nope")).toBeNull();
  });

  it("pins each attribute to the input type its column can hold", () => {
    expect(getBuiltinField("householdAdults")?.type).toBe("NUMBER");
    expect(getBuiltinField("phone")?.type).toBe("PHONE");
    expect(getBuiltinField("address")?.type).toBe("TEXT");
  });

  it("gives every entry a label key for the admin picker", () => {
    for (const f of MEMBER_BUILTIN_FIELDS) {
      expect(f.labelKey).toMatch(/^members\.builtinFields\./);
    }
  });
});

describe("coerceBuiltinValue — text columns", () => {
  it("trims a normal answer", () => {
    expect(coerceBuiltinValue("city", "  Brussels ")).toEqual({
      ok: true,
      value: "Brussels",
    });
  });

  it("maps blank and whitespace-only to null rather than an empty string", () => {
    expect(coerceBuiltinValue("address", "")).toEqual({ ok: true, value: null });
    expect(coerceBuiltinValue("address", "   ")).toEqual({ ok: true, value: null });
  });

  it("treats a missing answer as null", () => {
    expect(coerceBuiltinValue("city", undefined)).toEqual({ ok: true, value: null });
    expect(coerceBuiltinValue("city", null)).toEqual({ ok: true, value: null });
  });

  it("rejects text past the column's length budget", () => {
    expect(coerceBuiltinValue("address", "x".repeat(501)).ok).toBe(false);
    expect(coerceBuiltinValue("address", "x".repeat(500)).ok).toBe(true);
  });
});

describe("coerceBuiltinValue — number columns", () => {
  it("parses a whole number", () => {
    expect(coerceBuiltinValue("householdAdults", "3")).toEqual({
      ok: true,
      value: 3,
    });
  });

  it("accepts zero children", () => {
    expect(coerceBuiltinValue("householdChildren", "0")).toEqual({
      ok: true,
      value: 0,
    });
  });

  it("leaves an unanswered count null so the column default stands", () => {
    // Coercing blank to 0 would be indistinguishable from someone answering
    // "zero adults", which is not a real household.
    expect(coerceBuiltinValue("householdAdults", "")).toEqual({
      ok: true,
      value: null,
    });
  });

  it("rejects non-integers, negatives and absurd counts", () => {
    expect(coerceBuiltinValue("householdAdults", "2.5").ok).toBe(false);
    expect(coerceBuiltinValue("householdAdults", "-1").ok).toBe(false);
    expect(coerceBuiltinValue("householdAdults", "51").ok).toBe(false);
    expect(coerceBuiltinValue("householdAdults", "three").ok).toBe(false);
  });

  it("accepts the upper bound the admin edit form also allows", () => {
    expect(coerceBuiltinValue("householdAdults", "50")).toEqual({
      ok: true,
      value: 50,
    });
  });
});

describe("coerceBuiltinValue — wrong shapes", () => {
  it("rejects checkbox and multi-select values outright", () => {
    // No built-in column can hold these, so a tampered payload must fail
    // rather than be stringified into an address.
    expect(coerceBuiltinValue("address", true).ok).toBe(false);
    expect(coerceBuiltinValue("address", ["a", "b"]).ok).toBe(false);
  });

  it("rejects an unknown key", () => {
    expect(
      coerceBuiltinValue("notes" as never, "anything").ok,
    ).toBe(false);
  });
});
