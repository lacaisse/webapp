// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { symbolCollides } from "./symbol";

describe("symbolCollides", () => {
  it("matches case-insensitively and through invisible characters", () => {
    expect(symbolCollides("eure", ["CAISSE", "xDAI", "EURe"])).toBe(true);
    expect(symbolCollides("EUR\u200Be", ["EURe"])).toBe(true);
    expect(symbolCollides(" caisse ", ["CAISSE"])).toBe(true);
  });
  it("lets distinct symbols through and ignores empties", () => {
    expect(symbolCollides("USDC.e", ["CAISSE", "xDAI", "EURe", null, undefined])).toBe(false);
    expect(symbolCollides("", ["", "x"])).toBe(false);
  });
});
