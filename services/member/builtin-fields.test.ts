// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  coerceBuiltinValue,
  findShadowedBuiltinKey,
  getBuiltinField,
  isMemberBuiltinKey,
  MEMBER_BUILTIN_FIELDS,
} from "./builtin-fields";

describe("the built-in registry", () => {
  it("covers the postal address parts plus the tier picker", () => {
    expect(MEMBER_BUILTIN_FIELDS.map((f) => f.key)).toEqual([
      "address",
      "postalCode",
      "city",
      "tierId",
    ]);
  });

  it("excludes the attributes that are custom questions now", () => {
    // These moved to applicationData: nothing in the codebase reads the
    // columns, so they are ordinary extra data a fund may or may not collect.
    for (const key of ["phone", "iban", "householdAdults", "householdChildren"]) {
      expect(isMemberBuiltinKey(key)).toBe(false);
    }
  });

  it("excludes admin-internal and auto-captured columns", () => {
    for (const key of ["notes", "locale", "contributionAmount"]) {
      expect(isMemberBuiltinKey(key)).toBe(false);
    }
  });

  it("rejects unrelated columns and outright nonsense", () => {
    expect(isMemberBuiltinKey("status")).toBe(false);
    expect(isMemberBuiltinKey("paymentReference")).toBe(false);
    expect(isMemberBuiltinKey("")).toBe(false);
    expect(getBuiltinField("nope")).toBeNull();
  });

  it("pins the address parts to free text and the tier picker to a select", () => {
    for (const f of MEMBER_BUILTIN_FIELDS) {
      expect(f.type).toBe(f.key === "tierId" ? "SELECT" : "TEXT");
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

  it("accepts a tier id shape-only — the caller checks it's a real tier", () => {
    expect(coerceBuiltinValue("tierId", "clx1234567890")).toEqual({
      ok: true,
      value: "clx1234567890",
    });
    expect(coerceBuiltinValue("tierId", "")).toEqual({ ok: true, value: null });
    expect(coerceBuiltinValue("tierId", ["a"]).ok).toBe(false);
  });
});

describe("findShadowedBuiltinKey", () => {
  it("catches the lowercase spelling the key rule forces admins into", () => {
    // The create-time key rule is /^[a-z][a-z0-9_]*$/, so an admin reaching
    // for the postcode types `postalcode` — which is NOT the built-in
    // `postalCode`. This is exactly how issue #178 happened.
    expect(findShadowedBuiltinKey("postalcode")).toBe("postalCode");
    expect(findShadowedBuiltinKey("POSTALCODE")).toBe("postalCode");
  });

  it("catches exact matches on every registry attribute", () => {
    for (const f of MEMBER_BUILTIN_FIELDS) {
      expect(findShadowedBuiltinKey(f.key)).toBe(f.key);
    }
  });

  it("ignores surrounding whitespace, like the dialog's trimmed key", () => {
    expect(findShadowedBuiltinKey("  city  ")).toBe("city");
  });

  it("leaves genuinely custom keys alone", () => {
    expect(findShadowedBuiltinKey("householdAdults")).toBeNull();
    expect(findShadowedBuiltinKey("allocation")).toBeNull();
    // Near-misses must not trip it — these really are different questions.
    expect(findShadowedBuiltinKey("address_2")).toBeNull();
    expect(findShadowedBuiltinKey("billing_city")).toBeNull();
    expect(findShadowedBuiltinKey("")).toBeNull();
    expect(findShadowedBuiltinKey("   ")).toBeNull();
  });
});
