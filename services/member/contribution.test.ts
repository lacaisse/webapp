// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  contributionApplies,
  isBelowTierMinimum,
  resolveRequestedContribution,
} from "./contribution";

describe("contributionApplies", () => {
  it("is true only for FIXED_PERIOD funds that have tiers", () => {
    expect(contributionApplies("FIXED_PERIOD", 3)).toBe(true);
  });

  it("is false for FIXED_PERIOD funds with no tiers", () => {
    expect(contributionApplies("FIXED_PERIOD", 0)).toBe(false);
  });

  it("is false for non-FIXED_PERIOD modes even with tiers", () => {
    expect(contributionApplies("PAY_AND_GO", 3)).toBe(false);
    expect(contributionApplies("DISABLED", 3)).toBe(false);
  });
});

describe("resolveRequestedContribution", () => {
  it("prefers the member's committed amount over the tier target", () => {
    expect(resolveRequestedContribution("80.00", "100.00")).toBe("80.00");
  });

  it("falls back to the tier target when no commitment is set", () => {
    expect(resolveRequestedContribution(null, "100.00")).toBe("100.00");
    expect(resolveRequestedContribution(undefined, "100.00")).toBe("100.00");
  });

  it("returns empty string when neither is known (tier-less, no commitment)", () => {
    expect(resolveRequestedContribution(null, null)).toBe("");
    expect(resolveRequestedContribution(undefined, undefined)).toBe("");
  });

  it("uses a committed amount even when the member has no tier", () => {
    expect(resolveRequestedContribution("42.50", null)).toBe("42.50");
  });

  it("stringifies Decimal-like values via toString()", () => {
    const decimalish = { toString: () => "12.34" };
    expect(resolveRequestedContribution(decimalish, null)).toBe("12.34");
  });
});

describe("isBelowTierMinimum", () => {
  it("is true when the amount is under the tier floor", () => {
    expect(isBelowTierMinimum(40, 60)).toBe(true);
  });

  it("is false at or above the tier floor", () => {
    expect(isBelowTierMinimum(60, 60)).toBe(false);
    expect(isBelowTierMinimum(80, 60)).toBe(false);
  });

  it("has no floor for a tier-less member", () => {
    expect(isBelowTierMinimum(1, null)).toBe(false);
    expect(isBelowTierMinimum(1, undefined)).toBe(false);
  });
});
