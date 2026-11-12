// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/services/db/prisma", () => ({ prisma: {} }));

import { centsToEuroInput, euroToCents, normaliseFixedFeeInput } from "./fee-schema";
import { buildFeeWaiverLists } from "./fee-waivers";

describe("euroToCents / centsToEuroInput", () => {
  it("converts without float error", () => {
    expect(euroToCents("0.29")).toBe(29);
    expect(euroToCents("0.57")).toBe(57);
    expect(euroToCents("1,1")).toBe(110);
    expect(euroToCents("0")).toBe(0);
    expect(() => euroToCents("0.123")).toThrow();
  });

  it("formats cents for the form, empty for none", () => {
    expect(centsToEuroInput(10)).toBe("0.10");
    expect(centsToEuroInput(1000)).toBe("10.00");
    expect(centsToEuroInput(105)).toBe("1.05");
    expect(centsToEuroInput(0)).toBe("");
  });

  it("normalises the form value after a save", () => {
    expect(normaliseFixedFeeInput("0,1")).toBe("0.10");
    expect(normaliseFixedFeeInput(" 2 ")).toBe("2.00");
    expect(normaliseFixedFeeInput("   ")).toBe("");
    expect(normaliseFixedFeeInput("abc")).toBe("abc");
  });
});

describe("buildFeeWaiverLists", () => {
  const places = new Map([
    ["b-1", ["Mazette Ixelles", "Mazette Saint-Gilles"]],
    ["b-2", ["Café Central"]],
    ["b-3", ["Alpha Bakery"]],
  ]);

  it("names waivers with the fund's places and leaves only the others as candidates", () => {
    const res = buildFeeWaiverLists(
      [
        { businessId: "b-1", businessName: "Mazette", createdAt: null },
        { businessId: "b-x", businessName: "Elsewhere", createdAt: null },
      ],
      places,
    );
    expect(res.waivers).toEqual([
      { businessId: "b-x", businessName: "Elsewhere", placeNames: [] },
      {
        businessId: "b-1",
        businessName: "Mazette",
        placeNames: ["Mazette Ixelles", "Mazette Saint-Gilles"],
      },
    ]);
    expect(res.candidates.map((c) => c.businessId)).toEqual(["b-3", "b-2"]);
  });
});
