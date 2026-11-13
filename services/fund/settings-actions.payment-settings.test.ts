// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CitizenPayApiError } from "@/services/citizenpay/api";

// The payment-settings actions with the real apply step
// (sync-payment-settings.ts) against a fake Citizen Pay, Prisma and the
// recording helpers stubbed: a save converges CP to the value shown, a
// refusal reverts, nothing else pushes these settings.
vi.mock("server-only", () => ({}));
const { fund, fundUpdate, cp, record, adopt, options } = vi.hoisted(() => ({
  fund: { current: {} as Record<string, unknown> },
  fundUpdate: vi.fn(),
  cp: {
    getTreasuryPaymentSettings: vi.fn(),
    setTreasuryPaymentSettings: vi.fn(),
    setPayoutFeeConfig: vi.fn(),
  },
  record: vi.fn(),
  adopt: vi.fn(),
  options: vi.fn(),
}));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string, values?: Record<string, string>) =>
    values ? `${key} ${JSON.stringify(values)}` : key,
}));
vi.mock("@/services/auth/dal", () => ({
  requireFundRole: async () => ({ fund: fund.current, user: { id: "user-1" } }),
}));
vi.mock("@/services/db/prisma", () => ({ prisma: { fund: { update: fundUpdate }, card: {} } }));
vi.mock("@/services/citizenpay/client", () => ({ getCitizenPayClient: () => cp }));
vi.mock("./payment-settings", () => ({
  loadFeeAccountOptions: options,
  recordPaymentSettingOutcome: record,
  adoptRemotePaymentSetting: adopt,
  localPaymentSetting: (f: Record<string, unknown>, field: string) => f[field],
}));

import {
  adoptPaymentSettingAction,
  applyPaymentSettingAction,
  updatePaymentSettingsAction,
  updatePayoutFeeAction,
} from "./settings-actions";

const MAIN = "0x52908400098527886E0F7030069857D2E4169EE7";
const OTHER = "0x8617E340B3D01FA5F11F306F4090FD50E238070D";
const base = {
  id: "fund-1",
  citizenPayApiKeyId: "0xkey",
  citizenPayApiKeyEnc: "enc",
  feeAccountAddress: null,
  platformPayoutFeeBps: 0,
  earlyPaidMaxCents: null,
  feeCollectionFrequency: "PER_PAYMENT",
  payoutFixedFeeCents: 0,
};
let live: Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  fund.current = { ...base };
  fundUpdate.mockResolvedValue({});
  options.mockResolvedValue([{ address: MAIN, name: "Main account", kind: "minter" }]);
  live = { feeAccountAddress: null, payoutFeePercentageBps: 0, earlyPaidMaxCents: null, earlyPaidMaxCentsEffective: 5000 };
  cp.getTreasuryPaymentSettings.mockImplementation(async () => ({ ...live }));
  cp.setTreasuryPaymentSettings.mockImplementation(async (u: Record<string, unknown>) => {
    if ("feeAccountAddress" in u) live.feeAccountAddress = u.feeAccountAddress;
    if ("payoutFeePercentageBps" in u) live.payoutFeePercentageBps = u.payoutFeePercentageBps;
    if ("earlyPaidMaxCents" in u) live.earlyPaidMaxCents = u.earlyPaidMaxCents;
    return { ...live };
  });
  cp.setPayoutFeeConfig.mockResolvedValue({ fixedFeeCents: 0 });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("updatePaymentSettingsAction", () => {
  it("sends nothing when CP already applies the saved defaults", async () => {
    await expect(
      updatePaymentSettingsAction({ feeAccount: "none", platformPayoutFee: "", earlyPaid: { mode: "default" } }),
    ).resolves.toEqual({ ok: true });
    expect(cp.setTreasuryPaymentSettings).not.toHaveBeenCalled();
  });

  it("converges CP to the value shown even when La Caisse already stores it (W1)", async () => {
    live.feeAccountAddress = OTHER; // set on CP by a raw PATCH
    await expect(updatePaymentSettingsAction({ feeAccount: "none" })).resolves.toEqual({ ok: true });
    expect(cp.setTreasuryPaymentSettings).toHaveBeenCalledExactlyOnceWith({ feeAccountAddress: null });
    expect(record).toHaveBeenCalledWith("fund-1", "feeAccountAddress", null, { kind: "applied", changed: true }, "user-1");
  });

  it("stores the value pending first, then applies and records it", async () => {
    await updatePaymentSettingsAction({ platformPayoutFee: "1,5" });
    expect(fundUpdate).toHaveBeenCalledExactlyOnceWith({
      where: { id: "fund-1" },
      data: { platformPayoutFeeBps: 150, platformPayoutFeeSynced: false },
    });
    expect(cp.setTreasuryPaymentSettings).toHaveBeenCalledWith({ payoutFeePercentageBps: 150 });
  });

  it.each([
    [{ mode: "default" }, null],
    [{ mode: "none" }, 0],
    [{ mode: "custom", amount: "25" }, 2500],
  ] as const)("sends the cap %j as %s", async (earlyPaid, cents) => {
    live.earlyPaidMaxCents = 1234;
    await updatePaymentSettingsAction({ earlyPaid });
    expect(cp.setTreasuryPaymentSettings).toHaveBeenCalledWith({ earlyPaidMaxCents: cents });
  });

  it("refuses an address that is not one of the fund's accounts, writing nothing", async () => {
    await expect(updatePaymentSettingsAction({ feeAccount: OTHER })).resolves.toEqual({
      error: "settings.errors.feeAccountNotOwn",
    });
    expect(fundUpdate).not.toHaveBeenCalled();
    expect(cp.setTreasuryPaymentSettings).not.toHaveBeenCalled();
  });

  it("says 'will apply once the payments service is updated' on today's api, sending nothing", async () => {
    cp.getTreasuryPaymentSettings.mockResolvedValue({});
    await expect(updatePaymentSettingsAction({ earlyPaid: { mode: "none" } })).resolves.toEqual({
      ok: true,
      notice: "fund.settings.paymentSync.notYetSupported",
    });
    expect(cp.setTreasuryPaymentSettings).not.toHaveBeenCalled();
  });

  it("reverts the control to CP's value after a 400, with the api's message (W8)", async () => {
    live.feeAccountAddress = MAIN;
    cp.setTreasuryPaymentSettings.mockRejectedValueOnce(new CitizenPayApiError("not accepted", 400, null));
    await expect(updatePaymentSettingsAction({ feeAccount: "none" })).resolves.toEqual({
      ok: true,
      warning: 'fund.settings.paymentSync.refused {"message":"not accepted"}',
      revertedTo: { field: "feeAccountAddress", value: MAIN },
    });
  });

  it("treats a 409 on the payout fee as an error to show, not 'not supported' (W8)", async () => {
    cp.setTreasuryPaymentSettings.mockRejectedValueOnce(new CitizenPayApiError("conflict", 409, null));
    await expect(updatePaymentSettingsAction({ platformPayoutFee: "2" })).resolves.toMatchObject({
      warning: 'fund.settings.paymentSync.refused {"message":"conflict"}',
    });
  });

  it("only stores on an unconnected fund, with a notice", async () => {
    fund.current = { ...base, citizenPayApiKeyEnc: null };
    await expect(updatePaymentSettingsAction({ platformPayoutFee: "2" })).resolves.toEqual({
      ok: true,
      notice: "fund.settings.paymentSync.notConnected",
    });
    expect(cp.getTreasuryPaymentSettings).not.toHaveBeenCalled();
  });
});

describe("explicit apply / adopt", () => {
  it("'Apply now' pushes the stored value", async () => {
    fund.current = { ...base, earlyPaidMaxCents: 0 };
    await expect(applyPaymentSettingAction({ field: "earlyPaidMaxCents" })).resolves.toEqual({ ok: true });
    expect(cp.setTreasuryPaymentSettings).toHaveBeenCalledWith({ earlyPaidMaxCents: 0 });
  });

  it("'Use Citizen Pay's value' adopts what CP applies, read fresh", async () => {
    live.payoutFeePercentageBps = 150;
    await expect(adoptPaymentSettingAction({ field: "platformPayoutFeeBps" })).resolves.toEqual({ ok: true });
    expect(adopt).toHaveBeenCalledWith("fund-1", "platformPayoutFeeBps", 150, "user-1");
    expect(cp.setTreasuryPaymentSettings).not.toHaveBeenCalled();
  });
});

describe("no push from an unrelated save (W2)", () => {
  it("the transaction-fee save never touches the payment settings", async () => {
    fund.current = { ...base, platformPayoutFeeBps: 150, earlyPaidMaxCents: 0 }; // both pending
    await updatePayoutFeeAction({ payoutFeePercentage: "2.5", payoutFixedFee: "" });
    expect(cp.getTreasuryPaymentSettings).not.toHaveBeenCalled();
    expect(cp.setTreasuryPaymentSettings).not.toHaveBeenCalled();
  });
});
