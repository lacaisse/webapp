// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

// createFundAction with and without a waiver code (/new?code=): any signed-in
// account may open a fund; a usable code is claimed and the fund created
// waived in one transaction, and the code's last use going elsewhere
// meanwhile reads like a wrong code.
vi.mock("server-only", () => ({}));

const { prisma, tx, transaction, requireUser, revalidatePath, registerFundMcpResource } = vi.hoisted(() => {
  const tx = { subscriptionWaiverCode: { updateMany: vi.fn() }, fund: { create: vi.fn() } };
  const transaction = vi.fn();
  return {
    tx,
    transaction,
    prisma: {
      fund: { create: vi.fn() },
      subscriptionWaiverCode: { findUnique: vi.fn() },
      $transaction: transaction,
    },
    requireUser: vi.fn(),
    revalidatePath: vi.fn(),
    registerFundMcpResource: vi.fn(),
  };
});

vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
  getLocale: async () => "en",
}));
vi.mock("@/services/auth/dal", () => ({ requireUser }));
vi.mock("@/services/db/prisma", () => ({ prisma }));
vi.mock("@/services/mcp/auth", () => ({ registerFundMcpResource }));
vi.mock("@/services/token/minter", () => ({
  generateFundMinter: () => ({ privateKeyEnc: "v2:enc", eoaAddress: "0xEOA" }),
}));
vi.mock("./server", () => ({ getFundUrl: (domain: string) => `http://${domain}` }));

import { createFundAction } from "./actions";

const activeCode = {
  id: "code-1",
  code: "7K3PM2QX9RTD",
  label: "Registered non-profit",
  maxUses: 5,
  usedCount: 2,
  expiresAt: null,
  revokedAt: null,
};
const created = { id: "fund-1", name: "Acme", domain: "acme.lacaisse.eu" };

beforeEach(() => {
  vi.clearAllMocks();
  // A plain account: no staff row anywhere, no platform role — a card
  // holder's member login looks exactly like this.
  requireUser.mockResolvedValue({ id: "user-1", globalRole: "USER" });
  prisma.fund.create.mockResolvedValue(created);
  prisma.subscriptionWaiverCode.findUnique.mockResolvedValue(activeCode);
  transaction.mockImplementation(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx));
  tx.subscriptionWaiverCode.updateMany.mockResolvedValue({ count: 1 });
  tx.fund.create.mockResolvedValue(created);
});

describe("createFundAction", () => {
  it("without a code: any signed-in account writes the fund outside a transaction, not waived", async () => {
    const result = await createFundAction({ name: "Acme", subdomain: "acme" });
    expect(result).toEqual({ ok: true, redirectTo: "http://acme.lacaisse.eu" });
    expect(requireUser).toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
    const data = prisma.fund.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      name: "Acme",
      domain: "acme.lacaisse.eu",
      defaultLocale: "en",
      staff: { create: { userId: "user-1", role: "OWNER" } },
    });
    expect(data.subscriptionWaivedAt).toBeUndefined();
    expect(data.createdWithWaiverCodeId).toBeUndefined();
    expect(registerFundMcpResource).toHaveBeenCalledWith(created);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("is for signed-in accounts only: the gate's redirect to sign in surfaces before any read", async () => {
    requireUser.mockRejectedValue(new Error("REDIRECT:/login"));
    await expect(createFundAction({ name: "Acme", subdomain: "acme" })).rejects.toThrow("REDIRECT:/login");
    expect(prisma.subscriptionWaiverCode.findUnique).not.toHaveBeenCalled();
    expect(prisma.fund.create).not.toHaveBeenCalled();
  });

  it("with a code: claims a use and creates the fund waived in one transaction", async () => {
    const result = await createFundAction({ name: "Acme", subdomain: "acme", code: "7k3p-m2qx-9rtd" });
    expect(result).toEqual({ ok: true, redirectTo: "http://acme.lacaisse.eu" });
    expect(prisma.subscriptionWaiverCode.findUnique).toHaveBeenCalledWith({ where: { code: "7K3PM2QX9RTD" } });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(tx.subscriptionWaiverCode.updateMany).toHaveBeenCalledWith({
      where: {
        id: "code-1",
        revokedAt: null,
        usedCount: { lt: 5 },
        OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
      },
      data: { usedCount: { increment: 1 } },
    });
    expect(tx.fund.create.mock.calls[0][0].data).toMatchObject({
      domain: "acme.lacaisse.eu",
      subscriptionWaivedAt: expect.any(Date),
      subscriptionWaiverReason: "Registered non-profit",
      subscriptionWaiverCodeId: "code-1",
      createdWithWaiverCodeId: "code-1",
    });
    expect(prisma.fund.create).not.toHaveBeenCalled();
    expect(revalidatePath).toHaveBeenCalledWith("/admin/waivers");
  });

  it("with a code that no longer checks out: refuses without a transaction, in a wrong code's words", async () => {
    prisma.subscriptionWaiverCode.findUnique.mockResolvedValue({ ...activeCode, usedCount: 5 });
    expect(await createFundAction({ name: "Acme", subdomain: "acme", code: activeCode.code })).toEqual({
      error: "join.errors.codeInvalid",
    });
    expect(transaction).not.toHaveBeenCalled();
    expect(prisma.fund.create).not.toHaveBeenCalled();
  });

  it("with a code whose last use went elsewhere meanwhile: rolls back, same words", async () => {
    tx.subscriptionWaiverCode.updateMany.mockResolvedValue({ count: 0 });
    expect(await createFundAction({ name: "Acme", subdomain: "acme", code: activeCode.code })).toEqual({
      error: "join.errors.codeInvalid",
    });
    expect(tx.fund.create).not.toHaveBeenCalled();
    expect(registerFundMcpResource).not.toHaveBeenCalled();
  });

  it("names the subdomain when it is taken, with or without a code", async () => {
    const taken = Object.assign(new Error("unique"), { code: "P2002", meta: { target: ["domain"] } });
    prisma.fund.create.mockRejectedValue(taken);
    expect(await createFundAction({ name: "Acme", subdomain: "acme" })).toEqual({
      error: "funds.create.errors.subdomainTaken",
      field: "subdomain",
    });
    tx.fund.create.mockRejectedValue(taken);
    expect(await createFundAction({ name: "Acme", subdomain: "acme", code: activeCode.code })).toEqual({
      error: "funds.create.errors.subdomainTaken",
      field: "subdomain",
    });
  });
});
