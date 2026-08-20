// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  fromCents,
  maxManualDeductionCents,
  orderWalletCredit,
  payoutNet,
  suggestPayoutFee,
  toCents,
} from "./money";

describe("toCents / fromCents", () => {
  it("round-trips 2dp decimal strings", () => {
    expect(toCents("28.32")).toBe(2832);
    expect(fromCents(2832)).toBe("28.32");
  });

  it("rounds half up rather than truncating", () => {
    expect(toCents("0.125")).toBe(13);
  });

  it("reads missing / unparseable money as zero", () => {
    expect(toCents(null)).toBe(0);
    expect(toCents(undefined)).toBe(0);
    expect(toCents("")).toBe(0);
    expect(toCents("not-money")).toBe(0);
  });
});

describe("payoutNet", () => {
  it("subtracts both fee figures and the deduction", () => {
    expect(
      payoutNet({
        total: "510.00",
        fees: "10.00",
        payoutFees: "12.50",
        manualDeduction: "7.50",
      }),
    ).toBe("480.00");
  });

  it("treats an omitted deduction as zero", () => {
    expect(payoutNet({ total: "204.00", fees: "4.00", payoutFees: "5.00" })).toBe(
      "195.00",
    );
  });

  it("is unaffected by float dust in the inputs", () => {
    // 0.1 + 0.2 in floats is 0.30000000000000004; cents arithmetic isn't.
    expect(payoutNet({ total: "0.30", fees: "0.10", payoutFees: "0.20" })).toBe(
      "0.00",
    );
  });

  it("treats a payout predating the fee split (payoutFees 0) as fees-only", () => {
    expect(payoutNet({ total: "100.00", fees: "2.00", payoutFees: "0.00" })).toBe(
      "98.00",
    );
  });
});

describe("orderWalletCredit", () => {
  // The wallet credit is what a connector actually left in the place's wallet,
  // and it is the amount the reconcile mint reproduces.
  it("is the full total when nothing was withheld at source (ponto)", () => {
    expect(orderWalletCredit({ total: "12.00", fees: "0.00" })).toBe("12.00");
  });

  it("is total − commission when a processor withheld at source (viva/stripe)", () => {
    expect(orderWalletCredit({ total: "28.32", fees: "1.42" })).toBe("26.90");
  });

  it("ignores the platform cut — that is minted too, and swept later", () => {
    // Same order, whatever payoutFee CP assigns it: the credit doesn't move.
    expect(orderWalletCredit({ total: "28.32", fees: "1.42" })).toBe("26.90");
  });
});

describe("maxManualDeductionCents", () => {
  it("is the merchant's share before the adjustment", () => {
    expect(
      maxManualDeductionCents({
        total: "204.00",
        fees: "4.00",
        payoutFees: "5.00",
      }),
    ).toBe(19500);
  });

  it("counts the platform cut as already spoken for", () => {
    // The pre-split bound (total − fees) would have allowed 200.00 here and
    // driven net negative by the payout fee.
    const bound = maxManualDeductionCents({
      total: "204.00",
      fees: "4.00",
      payoutFees: "5.00",
    });
    expect(bound).toBeLessThan(toCents("200.00"));
  });

  it("never goes negative when the fees already exhaust the total", () => {
    expect(
      maxManualDeductionCents({
        total: "10.00",
        fees: "8.00",
        payoutFees: "5.00",
      }),
    ).toBe(0);
  });

  it("bounds a deduction that leaves exactly zero net", () => {
    const parts = { total: "50.00", fees: "0.00", payoutFees: "1.25" };
    const max = fromCents(maxManualDeductionCents(parts));
    expect(payoutNet({ ...parts, manualDeduction: max })).toBe("0.00");
  });
});

describe("suggestPayoutFee", () => {
  it("applies the fund's rate to the gross amount", () => {
    expect(suggestPayoutFee("204.00", "2.5")).toBe("5.10");
  });

  it("rounds to the cent", () => {
    expect(suggestPayoutFee("10.03", "2.5")).toBe("0.25");
  });

  it("suggests nothing when the fund has no rate configured", () => {
    expect(suggestPayoutFee("204.00", null)).toBe("0.00");
    expect(suggestPayoutFee("204.00", "0")).toBe("0.00");
    expect(suggestPayoutFee("204.00", "not-a-rate")).toBe("0.00");
  });
});
