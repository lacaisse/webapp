// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

// The fee-account eligibility QUERY, run against the in-memory Prisma
// stand-in (its where-semantics: equality / null), and the recording of an
// apply outcome.
vi.mock("server-only", () => ({}));
const { fake, events, updateMany } = vi.hoisted(() => ({
  fake: { current: null as unknown as { prisma: Record<string, unknown> } },
  events: vi.fn(),
  updateMany: vi.fn(),
}));
vi.mock("@/services/db/prisma", async () => {
  const { fake: f } = await import("@/services/safe/test-fake-prisma");
  fake.current = f as never;
  return {
    prisma: new Proxy(
      {},
      {
        get: (_t, key) =>
          key === "fund"
            ? { updateMany }
            : key === "fundPaymentSettingEvent"
              ? { create: events }
              : (f.prisma as Record<string, unknown>)[key as string],
      },
    ),
  };
});
vi.mock("@/services/citizenpay/client", () => ({ getCitizenPayClient: vi.fn() }));

import { fake as store, resetFake } from "@/services/safe/test-fake-prisma";

import { loadFeeAccountOptions, recordPaymentSettingOutcome } from "./payment-settings";

const FUND = { id: "fund-1", tokenMinterSmartAccountAddress: "0x52908400098527886E0F7030069857D2E4169EE7", tokenChainId: 100 };
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

beforeEach(() => {
  resetFake();
  vi.clearAllMocks();
  updateMany.mockResolvedValue({ count: 1 });
  store.db.fundTokenAccount.push(
    { fundId: "fund-1", name: "Savings", address: addr(1), kind: "STANDARD", archivedAt: null },
    { fundId: "fund-1", name: "Card source", address: addr(2), kind: "SOURCE", archivedAt: null },
    { fundId: "fund-1", name: "Old", address: addr(3), kind: "STANDARD", archivedAt: new Date() },
    { fundId: "fund-2", name: "Other fund", address: addr(4), kind: "STANDARD", archivedAt: null },
  );
  store.db.fundSafe.push(
    { fundId: "fund-1", name: "Board", address: addr(5), status: "ACTIVE", chainId: 100, archivedAt: null },
    { fundId: "fund-1", name: "Archived Safe", address: addr(6), status: "ACTIVE", chainId: 100, archivedAt: new Date() },
    { fundId: "fund-1", name: "Other chain", address: addr(7), status: "ACTIVE", chainId: 1, archivedAt: null },
    { fundId: "fund-1", name: "Deploying", address: addr(8), status: "DEPLOYING", chainId: 100, archivedAt: null },
    { fundId: "fund-2", name: "Other fund Safe", address: addr(9), status: "ACTIVE", chainId: 100, archivedAt: null },
  );
});

describe("loadFeeAccountOptions — own accounts only", () => {
  it("offers the main account, live STANDARD accounts and active Safes on the token's chain", async () => {
    const options = await loadFeeAccountOptions(FUND, "Main account");
    expect(options.map((o) => o.name)).toEqual(["Main account", "Savings", "Board"]);
    // Never: a SOURCE account, an archived account or Safe, a Safe on
    // another chain or not deployed, another fund's account or Safe.
    for (const n of [2, 3, 4, 6, 7, 8, 9]) {
      expect(options.some((o) => o.address.toLowerCase() === addr(n))).toBe(false);
    }
  });
});

describe("recordPaymentSettingOutcome", () => {
  it("records who applied a change, conditioned on the stored value", async () => {
    await recordPaymentSettingOutcome("fund-1", "platformPayoutFeeBps", 150, { kind: "applied", changed: true }, "user-1");
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "fund-1", platformPayoutFeeBps: 150 },
      data: { platformPayoutFeeSynced: true },
    });
    expect(events).toHaveBeenCalledWith({
      data: { fundId: "fund-1", field: "platformPayoutFeeBps", value: "150", action: "applied", userId: "user-1" },
    });
  });

  it("records nothing when CP already applied it", async () => {
    await recordPaymentSettingOutcome("fund-1", "earlyPaidMaxCents", null, { kind: "applied", changed: false }, "user-1");
    expect(events).not.toHaveBeenCalled();
  });

  it("puts a refused value back to what CP applies (W8)", async () => {
    await recordPaymentSettingOutcome(
      "fund-1",
      "feeAccountAddress",
      addr(1),
      { kind: "refused", message: "no", confirmed: null },
      "user-1",
    );
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "fund-1", feeAccountAddress: addr(1) },
      data: { feeAccountAddress: null, feeAccountSynced: true },
    });
  });

  it("keeps a non-default value pending on an api without it; a default is in force", async () => {
    await recordPaymentSettingOutcome("fund-1", "earlyPaidMaxCents", 0, { kind: "notSupported" }, "u");
    expect(updateMany.mock.calls[0][0].data).toEqual({ earlyPaidMaxCentsSynced: false });
    await recordPaymentSettingOutcome("fund-1", "earlyPaidMaxCents", null, { kind: "notSupported" }, "u");
    expect(updateMany.mock.calls[1][0].data).toEqual({ earlyPaidMaxCentsSynced: true });
  });
});
