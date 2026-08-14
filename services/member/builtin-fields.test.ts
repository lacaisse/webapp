// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  coerceBuiltinValue,
  getBuiltinField,
  isMemberBuiltinKey,
  MEMBER_BUILTIN_FIELDS,
} from "./builtin-fields";

describe("the built-in registry", () => {
  it("covers exactly the postal address parts", () => {
    expect(MEMBER_BUILTIN_FIELDS.map((f) => f.key)).toEqual([
      "address",
      "postalCode",
      "city",
    ]);
  });

  it("excludes the attributes that are custom questions now", () => {
    // These moved to applicationData: nothing in the codebase reads the
    // columns, so they are ordinary extra data a fund may or may not collect.
    for (const key of ["phone", "iban", "householdAdults", "householdChildren"]) {
      expect(isMemberBuiltinKey(key)).toBe(false);
    }
  });

  it("excludes admin-internal, auto-captured and allocation columns", () => {
    for (const key of ["notes", "locale", "tierId", "contributionAmount"]) {
      expect(isMemberBuiltinKey(key)).toBe(false);
    }
  });

  it("rejects unrelated columns and outright nonsense", () => {
    expect(isMemberBuiltinKey("status")).toBe(false);
    expect(isMemberBuiltinKey("paymentReference")).toBe(false);
    expect(isMemberBuiltinKey("")).toBe(false);
    expect(getBuiltinField("nope")).toBeNull();
  });

  it("pins every address part to free text", () => {
    for (const f of MEMBER_BUILTIN_FIELDS) {
      expect(f.type).toBe("TEXT");
    }
  });

  it("gives every entry a label key for the admin picker", () => {
    for (const f of MEMBER_BUILTIN_FIELDS) {
      expect(f.labelKey).toMatch(/^members\.builtinFields\./);
    }
  });
});

describe("coerceBuiltinValue", () => {
  it("trims a normal answer", () => {
    expect(coerceBuiltinValue("city", "  Brussels ")).toEqual({
      ok: true,
      value: "Brussels",
    });
  });

  it("maps blank and whitespace-only to null, not an empty string", () => {
    // formatMemberAddress skips null parts; an empty string would leave a
    // stray comma in the rendered address.
    expect(coerceBuiltinValue("address", "")).toEqual({ ok: true, value: null });
    expect(coerceBuiltinValue("address", "   ")).toEqual({
      ok: true,
      value: null,
    });
  });

  it("treats a missing answer as null", () => {
    expect(coerceBuiltinValue("city", undefined)).toEqual({
      ok: true,
      value: null,
    });
    expect(coerceBuiltinValue("city", null)).toEqual({ ok: true, value: null });
  });

  it("rejects text past the column's length budget", () => {
    expect(coerceBuiltinValue("address", "x".repeat(501)).ok).toBe(false);
    expect(coerceBuiltinValue("address", "x".repeat(500)).ok).toBe(true);
  });

  it("rejects checkbox and multi-select values outright", () => {
    // No address column can hold these, so a tampered payload must fail rather
    // than be stringified into a street name.
    expect(coerceBuiltinValue("address", true).ok).toBe(false);
    expect(coerceBuiltinValue("address", ["a", "b"]).ok).toBe(false);
  });

  it("rejects a key that is no longer (or never was) a built-in", () => {
    expect(coerceBuiltinValue("phone" as never, "+32470112233").ok).toBe(false);
    expect(coerceBuiltinValue("notes" as never, "anything").ok).toBe(false);
  });
});
