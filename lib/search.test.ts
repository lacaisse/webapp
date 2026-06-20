// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";
import { parseCardNumber, searchTokens } from "./search";

describe("searchTokens", () => {
  it("splits a multi-word query into tokens", () => {
    expect(searchTokens("John Doe")).toEqual(["John", "Doe"]);
  });

  it("collapses runs of whitespace and trims empties", () => {
    expect(searchTokens("  John   Doe  ")).toEqual(["John", "Doe"]);
  });

  it("returns an empty array for a blank query", () => {
    expect(searchTokens("   ")).toEqual([]);
  });
});

describe("parseCardNumber", () => {
  it("parses a plain integer", () => {
    expect(parseCardNumber("42")).toBe(42);
  });

  it("parses a #-prefixed integer", () => {
    expect(parseCardNumber("#42")).toBe(42);
  });

  it("returns null for alphanumeric serials so they fall through to contains", () => {
    expect(parseCardNumber("AB12")).toBeNull();
  });

  it("returns null for zero and negative input", () => {
    expect(parseCardNumber("0")).toBeNull();
    expect(parseCardNumber("-3")).toBeNull();
  });

  it("returns null for unsafe (overflowing) integers", () => {
    expect(parseCardNumber("99999999999999999999")).toBeNull();
  });
});
