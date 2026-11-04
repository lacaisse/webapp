// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { QuoteConversionSchema, StartConversionSchema } from "./schemas";

// The actions answer `t(issues[0].message)`: every refusal must be a key.
const VALID = { safeId: "s1", converterId: "eure-bread", amount: "10", slippageBps: 50, minOut: "123" };
const firstMessage = (r: { success: boolean; error?: { issues: { message: string }[] } }) =>
  r.success ? null : r.error?.issues[0]?.message;

describe("conversion schemas", () => {
  it("accept the dialog's input and default the slippage", () => {
    expect(StartConversionSchema.safeParse(VALID).success).toBe(true);
    const quote = { safeId: VALID.safeId, converterId: VALID.converterId, amount: VALID.amount };
    expect(QuoteConversionSchema.parse(quote).slippageBps).toBe(50);
  });

  it("refuse a bad minimum or slippage with an i18n key, never Zod's own words", () => {
    for (const minOut of ["12.5", "abc", "", "-1", 123, undefined]) {
      expect(firstMessage(StartConversionSchema.safeParse({ ...VALID, minOut }))).toBe("fund.safes.conversion.errors.amount");
    }
    for (const slippageBps of [0, 500, 2.5, "50"]) {
      expect(firstMessage(QuoteConversionSchema.safeParse({ ...VALID, slippageBps }))).toBe("fund.safes.errors.unknown");
    }
    expect(firstMessage(QuoteConversionSchema.safeParse({ ...VALID, amount: "x" }))).toBe("fund.safes.errors.amountInvalid");
  });

  it("take the quote the browser fetched as a status and a capped body, or nothing", () => {
    const relayed = { status: 200, text: '{"quote":{}}' };
    expect(QuoteConversionSchema.parse({ ...VALID, relayed }).relayed).toEqual(relayed);
    expect(StartConversionSchema.parse({ ...VALID, relayed }).relayed).toEqual(relayed);
    expect(QuoteConversionSchema.parse(VALID).relayed).toBeUndefined();
    for (const bad of [{ status: 200 }, { status: "200", text: "" }, { status: 99, text: "" }, { status: 200, text: "x".repeat(16_385) }]) {
      expect(firstMessage(QuoteConversionSchema.safeParse({ ...VALID, relayed: bad }))).toBe("fund.safes.errors.unknown");
    }
  });
});
