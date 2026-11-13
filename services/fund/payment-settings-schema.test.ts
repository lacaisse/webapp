// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import {
  bpsToPercentInput,
  earlyPaidField,
  earlyPaidFromCents,
  earlyPaidToCents,
  eligibleFeeAccounts,
  feeAccountField,
  parseFeeAccount,
  percentToBps,
  platformFeeField,
} from "./payment-settings-schema";

// The three payment settings' validation and conversions, shared by the
// forms and updatePaymentSettingsAction.

const A = "0x52908400098527886E0F7030069857D2E4169EE7"; // EIP-55
const B = "0x8617E340B3D01FA5F11F306F4090FD50E238070D";
const issue = (r: { success: boolean; error?: { issues: { message: string }[] } }) =>
  r.success ? null : r.error!.issues[0].message;

describe("fee account", () => {
  it("accepts none / empty / an address in any case, stores EIP-55 or null", () => {
    expect(issue(feeAccountField.safeParse("none"))).toBeNull();
    expect(issue(feeAccountField.safeParse(""))).toBeNull();
    expect(issue(feeAccountField.safeParse(A.toLowerCase()))).toBeNull();
    expect(parseFeeAccount("none")).toBeNull();
    expect(parseFeeAccount(" ")).toBeNull();
    expect(parseFeeAccount(A.toLowerCase())).toBe(A);
  });

  it("refuses anything else", () => {
    expect(issue(feeAccountField.safeParse("0x123"))).toBe("settings.errors.feeAccountInvalid");
    expect(issue(feeAccountField.safeParse("acme.eth"))).toBe("settings.errors.feeAccountInvalid");
  });

  it("offers the main account, STANDARD accounts and Safes, never SOURCE accounts, no duplicates", () => {
    expect(
      eligibleFeeAccounts({
        minterAddress: A.toLowerCase(),
        minterName: "Main account",
        accounts: [
          { name: "Savings", address: B, kind: "STANDARD" },
          { name: "Card source", address: "0x00000000000000000000000000000000000000C1", kind: "SOURCE" },
          { name: "Dup of main", address: A, kind: "STANDARD" },
        ],
        safes: [{ name: "Board Safe", address: "0x00000000000000000000000000000000000000D1" }],
      }),
    ).toEqual([
      { address: A, name: "Main account", kind: "minter" },
      { address: B, name: "Savings", kind: "account" },
      { address: "0x00000000000000000000000000000000000000D1", name: "Board Safe", kind: "safe" },
    ]);
  });

  it("has no main account entry for a fund without a minter", () => {
    expect(
      eligibleFeeAccounts({ minterAddress: null, minterName: "Main", accounts: [], safes: [] }),
    ).toEqual([]);
  });
});

describe("payout fee (percent → bps)", () => {
  it.each([
    ["", 0],
    ["0", 0],
    ["1.5", 150],
    ["0,75", 75],
    ["2.05", 205],
    ["100", 10_000],
  ])("%s → %i bps", (input, bps) => {
    expect(issue(platformFeeField.safeParse(input))).toBeNull();
    expect(percentToBps(input)).toBe(bps);
  });

  it.each([
    ["abc", "settings.errors.platformFeeInvalid"],
    ["1.234", "settings.errors.platformFeeInvalid"],
    ["-1", "settings.errors.platformFeeInvalid"],
    ["100.01", "settings.errors.platformFeeTooHigh"],
  ])("refuses %s", (input, key) => {
    expect(issue(platformFeeField.safeParse(input))).toBe(key);
  });

  it("renders bps back for the form", () => {
    expect(bpsToPercentInput(0)).toBe("");
    expect(bpsToPercentInput(150)).toBe("1.5");
    expect(bpsToPercentInput(205)).toBe("2.05");
    expect(bpsToPercentInput(10_000)).toBe("100");
  });
});

describe("instant confirmation cap", () => {
  it("default → null, no limit → 0, custom euros → cents", () => {
    expect(earlyPaidToCents({ mode: "default" })).toBeNull();
    expect(earlyPaidToCents({ mode: "none", amount: "12" })).toBe(0);
    expect(earlyPaidToCents({ mode: "custom", amount: "25" })).toBe(2500);
    expect(earlyPaidToCents({ mode: "custom", amount: "0,01" })).toBe(1);
    expect(earlyPaidToCents({ mode: "custom", amount: "1000.00" })).toBe(100_000);
  });

  it.each([
    [{ mode: "custom", amount: "" }, "settings.errors.earlyPaidInvalid"],
    [{ mode: "custom", amount: "12.345" }, "settings.errors.earlyPaidInvalid"],
    [{ mode: "custom", amount: "0" }, "settings.errors.earlyPaidRange"],
    [{ mode: "custom", amount: "1000.01" }, "settings.errors.earlyPaidRange"],
  ])("refuses %j", (input, key) => {
    expect(issue(earlyPaidField.safeParse(input))).toBe(key);
  });

  it("ignores the amount outside custom mode, refuses an unknown mode", () => {
    expect(issue(earlyPaidField.safeParse({ mode: "default", amount: "x" }))).toBeNull();
    expect(earlyPaidField.safeParse({ mode: "max" }).success).toBe(false);
  });

  it("maps the stored value back to the form", () => {
    expect(earlyPaidFromCents(null)).toEqual({ mode: "default", amount: "" });
    expect(earlyPaidFromCents(0)).toEqual({ mode: "none", amount: "" });
    expect(earlyPaidFromCents(2550)).toEqual({ mode: "custom", amount: "25.50" });
  });
});
