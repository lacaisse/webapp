// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { isDefaultValue, sameValue, viewPaymentSetting } from "./payment-settings-rules";

// What the settings page says about a payment setting, from La Caisse's value
// and Citizen Pay's live answer.

const A = "0x52908400098527886E0F7030069857D2E4169EE7";
const live = {
  feeAccountAddress: null,
  payoutFeePercentageBps: 0,
  earlyPaidMaxCents: null,
  earlyPaidMaxCentsEffective: 5000,
};

describe("viewPaymentSetting", () => {
  it("is in sync when CP applies La Caisse's value (address case ignored)", () => {
    expect(viewPaymentSetting("feeAccountAddress", A, { ...live, feeAccountAddress: A.toLowerCase() })).toEqual({
      state: "inSync",
    });
    expect(viewPaymentSetting("earlyPaidMaxCents", null, live)).toEqual({ state: "inSync" });
  });

  it("shows a value CP holds that La Caisse never set (W1: set by a raw PATCH)", () => {
    expect(viewPaymentSetting("feeAccountAddress", null, { ...live, feeAccountAddress: A })).toEqual({
      state: "drift",
      remote: A,
    });
    expect(
      viewPaymentSetting("platformPayoutFeeBps", 0, { ...live, payoutFeePercentageBps: 150 }),
    ).toEqual({ state: "drift", remote: 150 });
    expect(viewPaymentSetting("earlyPaidMaxCents", 0, live)).toEqual({ state: "drift", remote: null });
  });

  it("says 'not yet supported' only for a non-default value on an api without the field", () => {
    expect(viewPaymentSetting("platformPayoutFeeBps", 150, {})).toEqual({ state: "notYetSupported" });
    expect(viewPaymentSetting("platformPayoutFeeBps", 0, {})).toEqual({ state: "inSync" });
    expect(viewPaymentSetting("earlyPaidMaxCents", 0, {})).toEqual({ state: "notYetSupported" });
  });

  it("does not hide a failed read, nor a value on an unconnected fund", () => {
    expect(viewPaymentSetting("feeAccountAddress", A, "error")).toEqual({ state: "unreadable" });
    expect(viewPaymentSetting("feeAccountAddress", null, "error")).toEqual({ state: "unreadable" });
    expect(viewPaymentSetting("feeAccountAddress", A, null)).toEqual({ state: "notConnected" });
    expect(viewPaymentSetting("feeAccountAddress", null, null)).toEqual({ state: "inSync" });
  });
});

describe("defaults and equality", () => {
  it("knows each setting's default", () => {
    expect(isDefaultValue("feeAccountAddress", null)).toBe(true);
    expect(isDefaultValue("platformPayoutFeeBps", 0)).toBe(true);
    expect(isDefaultValue("earlyPaidMaxCents", null)).toBe(true);
    expect(isDefaultValue("earlyPaidMaxCents", 0)).toBe(false); // no limit is not the default
  });

  it("never treats an unreported value as equal", () => {
    expect(sameValue("earlyPaidMaxCents", null, undefined)).toBe(false);
    expect(sameValue("earlyPaidMaxCents", 0, null)).toBe(false);
  });
});
