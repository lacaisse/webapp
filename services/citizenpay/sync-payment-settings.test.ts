// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CitizenPayApiError } from "./api";

// applyPaymentSetting against a fake CP client: support read from the GET,
// one key per PATCH, confirmed by a second GET, and the per-field error
// contract (only the cap's 409 means "not supported yet").
vi.mock("server-only", () => ({}));

import { applyPaymentSetting } from "./sync-payment-settings";

const A = "0x52908400098527886E0F7030069857D2E4169EE7";
const full = {
  feeAccountAddress: null as string | null,
  payoutFeePercentageBps: 0,
  earlyPaidMaxCents: null as number | null,
  earlyPaidMaxCentsEffective: 5000,
};
let stored: typeof full;
const client = {
  getTreasuryPaymentSettings: vi.fn(),
  setTreasuryPaymentSettings: vi.fn(),
};
const log = { fundId: "fund-1" };

beforeEach(() => {
  vi.clearAllMocks();
  stored = { ...full };
  client.getTreasuryPaymentSettings.mockImplementation(async () => ({ ...stored }));
  client.setTreasuryPaymentSettings.mockImplementation(async (u: Record<string, unknown>) => {
    if ("payoutFeePercentageBps" in u) stored.payoutFeePercentageBps = u.payoutFeePercentageBps as number;
    if ("feeAccountAddress" in u) stored.feeAccountAddress = u.feeAccountAddress as string | null;
    if ("earlyPaidMaxCents" in u) stored.earlyPaidMaxCents = u.earlyPaidMaxCents as number | null;
    return { ...stored };
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("applyPaymentSetting", () => {
  it("sends nothing when CP already applies the value", async () => {
    await expect(applyPaymentSetting(client, "earlyPaidMaxCents", null, log)).resolves.toEqual({
      kind: "applied",
      changed: false,
    });
    expect(client.setTreasuryPaymentSettings).not.toHaveBeenCalled();
  });

  it("PATCHes one key and confirms with a GET (W7)", async () => {
    await expect(applyPaymentSetting(client, "feeAccountAddress", A, log)).resolves.toEqual({
      kind: "applied",
      changed: true,
    });
    expect(client.setTreasuryPaymentSettings).toHaveBeenCalledExactlyOnceWith({ feeAccountAddress: A });
    expect(client.getTreasuryPaymentSettings).toHaveBeenCalledTimes(2);
  });

  it("clears a value CP holds when La Caisse wants the default (W1)", async () => {
    stored.feeAccountAddress = A;
    await applyPaymentSetting(client, "feeAccountAddress", null, log);
    expect(client.setTreasuryPaymentSettings).toHaveBeenCalledWith({ feeAccountAddress: null });
    expect(stored.feeAccountAddress).toBeNull();
  });

  it("is not applied when the read-back holds another value (a concurrent save won)", async () => {
    client.setTreasuryPaymentSettings.mockResolvedValue({ ...full, payoutFeePercentageBps: 150 });
    client.getTreasuryPaymentSettings
      .mockResolvedValueOnce({ ...full })
      .mockResolvedValueOnce({ ...full, payoutFeePercentageBps: 200 });
    await expect(applyPaymentSetting(client, "platformPayoutFeeBps", 150, log)).resolves.toEqual({
      kind: "failed",
    });
  });

  it("never sends a field the api does not report (today's api)", async () => {
    client.getTreasuryPaymentSettings.mockResolvedValue({});
    await expect(applyPaymentSetting(client, "platformPayoutFeeBps", 150, log)).resolves.toEqual({
      kind: "notSupported",
    });
    expect(client.setTreasuryPaymentSettings).not.toHaveBeenCalled();
  });

  it("reads the cap's 409 as 'not supported yet' (W8)", async () => {
    client.setTreasuryPaymentSettings.mockRejectedValue(
      new CitizenPayApiError("earlyPaidMaxCents is not available yet", 409, null),
    );
    await expect(applyPaymentSetting(client, "earlyPaidMaxCents", 0, log)).resolves.toEqual({
      kind: "notSupported",
    });
  });

  it("reads a 409 on the other settings, and any 400, as a refusal with what CP still applies (W8)", async () => {
    stored.feeAccountAddress = A;
    client.setTreasuryPaymentSettings.mockRejectedValueOnce(
      new CitizenPayApiError("conflict", 409, null),
    );
    await expect(applyPaymentSetting(client, "feeAccountAddress", null, log)).resolves.toEqual({
      kind: "refused",
      message: "conflict",
      confirmed: A,
    });
    client.setTreasuryPaymentSettings.mockRejectedValueOnce(
      new CitizenPayApiError("feeAccountAddress must be the fund's own fee account", 400, null),
    );
    await expect(
      applyPaymentSetting(client, "feeAccountAddress", "0x8617E340B3D01FA5F11F306F4090FD50E238070D", log),
    ).resolves.toEqual({
      kind: "refused",
      message: "feeAccountAddress must be the fund's own fee account",
      confirmed: A,
    });
  });

  it("fails (pending) on an unreadable api or a network error", async () => {
    client.getTreasuryPaymentSettings.mockRejectedValueOnce(new Error("timeout"));
    await expect(applyPaymentSetting(client, "earlyPaidMaxCents", 0, log)).resolves.toEqual({ kind: "failed" });
    client.setTreasuryPaymentSettings.mockRejectedValueOnce(new Error("ECONNRESET"));
    await expect(applyPaymentSetting(client, "earlyPaidMaxCents", 0, log)).resolves.toEqual({ kind: "failed" });
  });
});
