// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Pins redeemWaiverCodeAction: shape errors before any read, the code's state
// named precisely, one transaction that claims a use and marks the fund,
// rolled back (and the race named) when the fund settled meanwhile.
vi.mock("server-only", () => ({}));
const { state, codeFindUnique, codeUpdateMany, fundUpdateMany, fundFindUnique, transaction } =
  vi.hoisted(() => ({
    state: {
      fund: {
        id: "fund-1",
        name: "La Class",
        domain: "laclass.lacaisse.eu",
        defaultLocale: "fr",
        primaryColor: null,
        logoUrl: null,
        citizenPayFundId: "treasury-1",
        citizenPayBusinessId: null,
        subscriptionAcceptedAt: null as Date | null,
        subscriptionWaivedAt: null as Date | null,
      },
    },
    codeFindUnique: vi.fn(),
    codeUpdateMany: vi.fn(),
    fundUpdateMany: vi.fn(),
    fundFindUnique: vi.fn(),
    transaction: vi.fn(),
  }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next-intl/server", () => ({
  getTranslations: async (ns?: string) => (key: string) => (ns ? `${ns}.${key}` : key),
}));
vi.mock("@/services/auth/dal", () => ({
  requireFundRole: async () => ({
    user: { id: "user-1", email: "owner@example.org" },
    fund: state.fund,
    membership: { role: "OWNER" },
  }),
}));
vi.mock("@/services/db/prisma", () => ({
  prisma: {
    fund: { updateMany: fundUpdateMany, findUnique: fundFindUnique },
    subscriptionWaiverCode: { findUnique: codeFindUnique, updateMany: codeUpdateMany },
    $transaction: transaction,
  },
}));
vi.mock("./emails", () => ({ sendSubscriptionEmails: vi.fn() }));

import { redeemWaiverCodeAction } from "./admin-actions";

const E = "fund.settings.subscription.errors";

const activeCode = {
  id: "code-1",
  code: "7K3PM2QX9RTD",
  label: "Contributor: Alice",
  maxUses: 1,
  usedCount: 0,
  expiresAt: null,
  revokedAt: null,
};

// The interactive transaction runs the callback against the same mocks.
function runTransaction() {
  transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      fund: { updateMany: fundUpdateMany },
      subscriptionWaiverCode: { updateMany: codeUpdateMany },
    }),
  );
}

beforeEach(() => {
  state.fund.subscriptionAcceptedAt = null;
  state.fund.subscriptionWaivedAt = null;
  codeFindUnique.mockReset();
  codeUpdateMany.mockReset();
  fundUpdateMany.mockReset();
  fundFindUnique.mockReset();
  transaction.mockReset();
  runTransaction();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("redeemWaiverCodeAction", () => {
  it("refuses a malformed code before reading anything", async () => {
    expect(await redeemWaiverCodeAction({ code: "" })).toEqual({ error: `${E}.codeRequired` });
    expect(await redeemWaiverCodeAction({ code: "nope" })).toEqual({ error: `${E}.codeInvalid` });
    expect(codeFindUnique).not.toHaveBeenCalled();
  });

  it("refuses when the fund already accepted or was already waived", async () => {
    state.fund.subscriptionAcceptedAt = new Date();
    expect(await redeemWaiverCodeAction({ code: "7K3P-M2QX-9RTD" })).toEqual({
      error: `${E}.alreadyAccepted`,
    });
    state.fund.subscriptionAcceptedAt = null;
    state.fund.subscriptionWaivedAt = new Date();
    expect(await redeemWaiverCodeAction({ code: "7K3P-M2QX-9RTD" })).toEqual({
      error: `${E}.alreadyWaived`,
    });
    expect(codeFindUnique).not.toHaveBeenCalled();
  });

  it("looks the code up normalised and names an unknown one invalid", async () => {
    codeFindUnique.mockResolvedValue(null);
    expect(await redeemWaiverCodeAction({ code: " 7k3p-m2qx-9rtd " })).toEqual({
      error: `${E}.codeInvalid`,
    });
    expect(codeFindUnique).toHaveBeenCalledWith({ where: { code: "7K3PM2QX9RTD" } });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("names a revoked, expired or used-up code without writing", async () => {
    codeFindUnique.mockResolvedValueOnce({ ...activeCode, revokedAt: new Date() });
    expect(await redeemWaiverCodeAction({ code: activeCode.code })).toEqual({
      error: `${E}.codeRevoked`,
    });
    codeFindUnique.mockResolvedValueOnce({ ...activeCode, expiresAt: new Date(Date.now() - 1000) });
    expect(await redeemWaiverCodeAction({ code: activeCode.code })).toEqual({
      error: `${E}.codeExpired`,
    });
    codeFindUnique.mockResolvedValueOnce({ ...activeCode, usedCount: 1 });
    expect(await redeemWaiverCodeAction({ code: activeCode.code })).toEqual({
      error: `${E}.codeExhausted`,
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("claims a use and marks the fund waived with the code's label, in one transaction", async () => {
    codeFindUnique.mockResolvedValue(activeCode);
    codeUpdateMany.mockResolvedValue({ count: 1 });
    fundUpdateMany.mockResolvedValue({ count: 1 });

    const result = await redeemWaiverCodeAction({ code: "7K3P-M2QX-9RTD" });

    expect(result).toEqual({ ok: true, reason: "Contributor: Alice" });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(codeUpdateMany).toHaveBeenCalledWith({
      where: {
        id: "code-1",
        revokedAt: null,
        usedCount: { lt: 1 },
        OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
      },
      data: { usedCount: { increment: 1 } },
    });
    expect(fundUpdateMany).toHaveBeenCalledWith({
      where: { id: "fund-1", subscriptionAcceptedAt: null, subscriptionWaivedAt: null },
      data: {
        subscriptionWaivedAt: expect.any(Date),
        subscriptionWaiverReason: "Contributor: Alice",
        subscriptionWaiverCodeId: "code-1",
      },
    });
  });

  it("names the race when the code's last use went to someone else", async () => {
    codeFindUnique
      .mockResolvedValueOnce(activeCode) // the pre-check saw a use left
      .mockResolvedValueOnce({ ...activeCode, usedCount: 1 }); // re-read after the lost claim
    codeUpdateMany.mockResolvedValue({ count: 0 });

    expect(await redeemWaiverCodeAction({ code: activeCode.code })).toEqual({
      error: `${E}.codeExhausted`,
    });
    expect(fundUpdateMany).not.toHaveBeenCalled();
  });

  it("rolls the claimed use back when the fund settled meanwhile, and says how", async () => {
    codeFindUnique.mockResolvedValue(activeCode);
    codeUpdateMany.mockResolvedValue({ count: 1 });
    fundUpdateMany.mockResolvedValue({ count: 0 });
    fundFindUnique.mockResolvedValue({ subscriptionAcceptedAt: new Date() });

    const result = await redeemWaiverCodeAction({ code: activeCode.code });

    // The callback threw, so the real $transaction would roll back; here the
    // mock surfaces the throw as the rejected promise the action catches.
    expect(result).toEqual({ error: `${E}.alreadyAccepted` });
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
