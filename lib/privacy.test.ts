// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { isPrivacyCookieOn, maskValue } from "./privacy";

describe("privacy helpers", () => {
  it("treats only the literal '1' as on", () => {
    expect(isPrivacyCookieOn("1")).toBe(true);
    expect(isPrivacyCookieOn("true")).toBe(false);
    expect(isPrivacyCookieOn(undefined)).toBe(false);
  });

  it("returns a placeholder that never contains digits or letters", () => {
    for (const kind of [
      "name",
      "email",
      "phone",
      "number",
      "amount",
      "address",
      "text",
    ] as const) {
      expect(maskValue(kind)).not.toMatch(/[0-9a-z]/i);
    }
    // IBAN keeps the country prefix so the column still reads as an IBAN.
    expect(maskValue("iban")).toMatch(/^BE/);
  });
});
