// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { ProposeTransferSchema } from "./schemas";

const base = {
  safeId: "safe-1",
  recipient: "0x9999999999999999999999999999999999999999",
  amount: "1",
};

describe("ProposeTransferSchema.token", () => {
  it("defaults to the fund token", () => {
    expect(ProposeTransferSchema.parse(base).token).toBe("fund");
  });

  it("accepts the built-ins and a lowercase custom:<address> key", () => {
    for (const token of [
      "fund",
      "native",
      "eure",
      "custom:0x2a22f9c3b484c3629090feed35f17ff8f88f76f0",
    ]) {
      expect(ProposeTransferSchema.parse({ ...base, token }).token).toBe(token);
    }
  });

  it("refuses anything else", () => {
    for (const token of [
      "usdc",
      "custom:0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0", // not lowercased
      "custom:0x1234",
      "custom:",
    ]) {
      const res = ProposeTransferSchema.safeParse({ ...base, token });
      expect(res.success).toBe(false);
      expect(res.error?.issues[0]?.message).toBe("fund.safes.errors.tokenNotEnabled");
    }
  });
});
