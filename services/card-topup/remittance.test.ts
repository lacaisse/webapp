// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { parseTopUpRemittance } from "./remittance";

describe("parseTopUpRemittance", () => {
  it.each([
    ["cp-123", 123],
    ["CP-4567", 4567],
    ["  cp-89  ", 89],
    ["Virement cp-1001 /ref", 1001],
    ["/cp-42/", 42],
  ])("reads %j as payment request %i", (ref, id) => {
    expect(parseTopUpRemittance(ref)).toBe(id);
  });

  it.each([
    "cp-order-123", // an order's payment, not a top-up
    "cp-0",
    "cp123", // no hyphen
    "CP 1000 Bruxelles", // a postcode
    "xcp-12", // glued to a word
    "abc-cp-12",
    "cp-12-3",
    "class-04516F320A1291",
    "+++000/0000/01717+++",
    "",
  ])("ignores %j", (ref) => {
    expect(parseTopUpRemittance(ref)).toBeNull();
  });

  it("checks each reference in order and skips empty ones", () => {
    expect(parseTopUpRemittance(null, undefined, "cp-7")).toBe(7);
    expect(parseTopUpRemittance("cp-order-1", "cp-8")).toBe(8);
  });
});
