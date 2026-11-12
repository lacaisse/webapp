// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

// updatePayoutFeeAction: the fixed fee per order beside the rate. Pins the
// euro → cents conversion, when the PATCH goes out, and that the fee only
// counts as synced when CP echoes the fixed fee sent. Prisma and the CP
// client are stubbed; nothing leaves the process.
vi.mock("server-only", () => ({}));
const { fund, fundUpdate, setPayoutFeeConfig } = vi.hoisted(() => ({
  fund: {
    current: {} as Record<string, unknown>,
  },
  fundUpdate: vi.fn(),
  setPayoutFeeConfig: vi.fn(),
}));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));
vi.mock("@/services/auth/dal", () => ({
  requireFundRole: async () => ({ fund: fund.current }),
}));
vi.mock("@/services/db/prisma", () => ({
  prisma: { fund: { update: fundUpdate }, card: {} },
}));
vi.mock("@/services/citizenpay/client", () => ({
  getCitizenPayClient: () => ({ setPayoutFeeConfig }),
}));

import { updatePayoutFeeAction } from "./settings-actions";

const base = {
  id: "fund-1",
  feeCollectionFrequency: "PER_PAYMENT",
  payoutFixedFeeCents: 0,
};

// The data of every prisma.fund.update, in order.
const writes = () => fundUpdate.mock.calls.map(([arg]) => arg.data);

beforeEach(() => {
  fund.current = { ...base };
  fundUpdate.mockReset();
  fundUpdate.mockResolvedValue({});
  setPayoutFeeConfig.mockReset();
  // An up-to-date api: echoes what it was sent.
  setPayoutFeeConfig.mockImplementation(async (c: { fixedFeeCents: number }) => ({
    fixedFeeCents: c.fixedFeeCents,
  }));
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("updatePayoutFeeAction — fixed fee", () => {
  it.each([
    ["0.10", 10],
    ["0,29", 29],
    ["1.5", 150],
    ["10", 1000],
    ["0.01", 1],
  ])("stores and sends %s as %i cents", async (input, cents) => {
    await expect(
      updatePayoutFeeAction({ payoutFeePercentage: "2.5", payoutFixedFee: input }),
    ).resolves.toEqual({ ok: true });
    expect(writes()[0]).toMatchObject({ payoutFixedFeeCents: cents, payoutFeeSynced: false });
    expect(setPayoutFeeConfig).toHaveBeenCalledExactlyOnceWith({
      percent: "2.5",
      collectionFrequency: "PER_PAYMENT",
      fixedFeeCents: cents,
    });
    expect(writes()[1]).toEqual({ payoutFeeSynced: true });
  });

  it("pushes a fixed fee with an empty rate without any rate (CP keeps its own)", async () => {
    await expect(
      updatePayoutFeeAction({ payoutFeePercentage: "", payoutFixedFee: "0.10" }),
    ).resolves.toEqual({ ok: true });
    expect(writes()[0]).toMatchObject({ payoutFeePercentage: null, payoutFixedFeeCents: 10 });
    expect(setPayoutFeeConfig).toHaveBeenCalledWith(
      expect.objectContaining({ percent: null, fixedFeeCents: 10 }),
    );
    expect(writes()[1]).toEqual({ payoutFeeSynced: true });
  });

  it("puts no rate and no cadence on the wire when the rate is empty", async () => {
    // Through the real live client, with only fetch faked: the request body
    // must not carry feePercentageBps (CP would reset its rate to 0).
    const { LiveCitizenPayClient } = await vi.importActual<
      typeof import("@/services/citizenpay/live-client")
    >("@/services/citizenpay/live-client");
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return Response.json({ fixedFeeCents: 10 });
      }),
    );
    const live = new LiveCitizenPayClient({ baseUrl: "https://cp.test", apiKeyId: "k", apiKey: "s" });
    setPayoutFeeConfig.mockImplementation((c) => live.setPayoutFeeConfig(c));
    await expect(
      updatePayoutFeeAction({ payoutFeePercentage: "", payoutFixedFee: "0.10" }),
    ).resolves.toEqual({ ok: true });
    expect(bodies).toEqual([{ fixedFeeCents: 10 }]);
    expect(bodies[0]).not.toHaveProperty("feePercentageBps");
    expect(bodies[0]).not.toHaveProperty("feeCollectionFrequency");
    vi.unstubAllGlobals();
  });

  it("pushes 0 when clearing a stored fixed fee, even with no rate", async () => {
    fund.current = { ...base, payoutFixedFeeCents: 10 };
    await expect(
      updatePayoutFeeAction({ payoutFeePercentage: "", payoutFixedFee: "" }),
    ).resolves.toEqual({ ok: true });
    expect(writes()[0]).toMatchObject({ payoutFixedFeeCents: 0, payoutFeeSynced: false });
    expect(setPayoutFeeConfig).toHaveBeenCalledWith(
      expect.objectContaining({ percent: null, fixedFeeCents: 0 }),
    );
    expect(writes()[1]).toEqual({ payoutFeeSynced: true });
  });

  it("pushes nothing with no rate and no fixed fee before or after", async () => {
    await expect(
      updatePayoutFeeAction({ payoutFeePercentage: "", payoutFixedFee: "" }),
    ).resolves.toEqual({ ok: true });
    expect(setPayoutFeeConfig).not.toHaveBeenCalled();
    expect(writes()).toEqual([
      {
        payoutFeePercentage: null,
        feeCollectionFrequency: "PER_PAYMENT",
        payoutFixedFeeCents: 0,
        payoutFeeSynced: true,
      },
    ]);
  });

  it("treats a whitespace-only fixed fee as empty (0)", async () => {
    fund.current = { ...base, payoutFixedFeeCents: 10 };
    await expect(
      updatePayoutFeeAction({ payoutFeePercentage: "2", payoutFixedFee: "   " }),
    ).resolves.toEqual({ ok: true });
    expect(writes()[0]).toMatchObject({ payoutFixedFeeCents: 0 });
  });

  it("keeps the stored fixed fee when the caller doesn't send the field", async () => {
    fund.current = { ...base, payoutFixedFeeCents: 25 };
    await updatePayoutFeeAction({ payoutFeePercentage: "1" });
    expect(writes()[0]).toMatchObject({ payoutFixedFeeCents: 25 });
    expect(setPayoutFeeConfig).toHaveBeenCalledWith(
      expect.objectContaining({ fixedFeeCents: 25 }),
    );
  });

  it("stays unsynced with the warning when CP doesn't echo a non-zero fee (older api)", async () => {
    setPayoutFeeConfig.mockResolvedValue({ fixedFeeCents: null });
    await expect(
      updatePayoutFeeAction({ payoutFeePercentage: "2", payoutFixedFee: "0.10" }),
    ).resolves.toEqual({ ok: true, warning: "fund.settings.fees.syncFailed" });
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({ payoutFixedFeeCents: 10, payoutFeeSynced: false });
  });

  it("stays unsynced when CP echoes a different value", async () => {
    setPayoutFeeConfig.mockResolvedValue({ fixedFeeCents: 0 });
    await expect(
      updatePayoutFeeAction({ payoutFeePercentage: "2", payoutFixedFee: "0.10" }),
    ).resolves.toEqual({ ok: true, warning: "fund.settings.fees.syncFailed" });
    expect(writes()).toHaveLength(1);
  });

  it("counts a missing echo as synced for a fixed fee of 0 (an older api charges none)", async () => {
    setPayoutFeeConfig.mockResolvedValue({ fixedFeeCents: null });
    await expect(
      updatePayoutFeeAction({ payoutFeePercentage: "2", payoutFixedFee: "" }),
    ).resolves.toEqual({ ok: true });
    expect(writes()[1]).toEqual({ payoutFeeSynced: true });
  });

  it("keeps the DB values and warns when the push fails", async () => {
    setPayoutFeeConfig.mockRejectedValue(new Error("CP down"));
    await expect(
      updatePayoutFeeAction({ payoutFeePercentage: "2", payoutFixedFee: "0.10" }),
    ).resolves.toEqual({ ok: true, warning: "fund.settings.fees.syncFailed" });
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({ payoutFixedFeeCents: 10, payoutFeeSynced: false });
  });

  it.each([
    ["10.01", "settings.errors.fixedFeeTooHigh"],
    ["11", "settings.errors.fixedFeeTooHigh"],
    ["0.105", "settings.errors.fixedFeeInvalid"],
    ["-1", "settings.errors.fixedFeeInvalid"],
    ["abc", "settings.errors.fixedFeeInvalid"],
    ["1e2", "settings.errors.fixedFeeInvalid"],
  ])("refuses %s with %s and writes nothing", async (input, key) => {
    await expect(
      updatePayoutFeeAction({ payoutFeePercentage: "2", payoutFixedFee: input }),
    ).resolves.toEqual({ error: key });
    expect(fundUpdate).not.toHaveBeenCalled();
    expect(setPayoutFeeConfig).not.toHaveBeenCalled();
  });
});
