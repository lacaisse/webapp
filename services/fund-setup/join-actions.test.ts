// SPDX-License-Identifier: AGPL-3.0-or-later
import { APIError } from "better-auth/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Pins joinWithCodeAction (the apex /join door): shape errors before any read,
// one vague answer for an unusable code, an existing account told to sign in,
// and the one transaction — claim a use, User + credential Account, the fund
// waived and marked created-with — with each race answered: the code's last
// use gone meanwhile, the email taken meanwhile, the subdomain taken
// meanwhile.
vi.mock("server-only", () => ({}));

const { prisma, transaction, tx, allowJoinSubmit, signInEmail, buildPostAuthRedirect, revalidatePath, registerFundMcpResource } =
  vi.hoisted(() => {
    const tx = {
      subscriptionWaiverCode: { updateMany: vi.fn() },
      user: { create: vi.fn() },
      account: { create: vi.fn() },
      fund: { create: vi.fn() },
    };
    const transaction = vi.fn();
    return {
      tx,
      transaction,
      prisma: {
        user: { findFirst: vi.fn() },
        subscriptionWaiverCode: { findUnique: vi.fn() },
        $transaction: transaction,
      },
      allowJoinSubmit: vi.fn(),
      signInEmail: vi.fn(),
      buildPostAuthRedirect: vi.fn(),
      revalidatePath: vi.fn(),
      registerFundMcpResource: vi.fn(),
    };
  });

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/cache", () => ({ revalidatePath }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
  getLocale: async () => "fr",
}));
vi.mock("@/services/db/prisma", () => ({ prisma }));
vi.mock("@/services/auth/better-auth", () => ({
  auth: {
    $context: Promise.resolve({ password: { hash: async (p: string) => `hashed:${p}` } }),
    api: { signInEmail },
  },
}));
vi.mock("@/services/auth/redirects", () => ({ buildPostAuthRedirect }));
vi.mock("@/services/mcp/auth", () => ({ registerFundMcpResource }));
vi.mock("@/services/token/minter", () => ({
  generateFundMinter: () => ({ privateKeyEnc: "v2:enc", eoaAddress: "0xEOA" }),
}));
vi.mock("@/services/host/server", () => ({
  getAuthUrl: (path: string) => `http://auth.localhost:3000${path}`,
}));
vi.mock("./join", () => ({ allowJoinSubmit }));

import { joinWithCodeAction } from "./join-actions";

const activeCode = {
  id: "code-1",
  code: "7K3PM2QX9RTD",
  label: "Contributor: Alice",
  maxUses: 1,
  usedCount: 0,
  expiresAt: null,
  revokedAt: null,
};

const VALID = {
  code: "7k3p-m2qx-9rtd",
  email: " Alice@Example.org ",
  password: "correct horse",
  name: "La Class",
  subdomain: "laclass",
};

const SIGN_IN_URL =
  "http://auth.localhost:3000/login?return_to=" +
  encodeURIComponent("http://localhost:3000/new?code=" + encodeURIComponent("7K3P-M2QX-9RTD"));

function uniqueViolation(target: string[]) {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002", meta: { target } });
}

beforeEach(() => {
  process.env.APP_DOMAIN = "localhost";
  process.env.PORT = "3000";
  vi.clearAllMocks();
  allowJoinSubmit.mockResolvedValue(true);
  prisma.user.findFirst.mockResolvedValue(null);
  prisma.subscriptionWaiverCode.findUnique.mockResolvedValue(activeCode);
  transaction.mockImplementation(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx));
  tx.subscriptionWaiverCode.updateMany.mockResolvedValue({ count: 1 });
  tx.user.create.mockResolvedValue({ id: "user-1" });
  tx.account.create.mockResolvedValue({});
  tx.fund.create.mockResolvedValue({ id: "fund-1", name: "La Class", domain: "laclass.lacaisse.eu" });
  signInEmail.mockResolvedValue({});
  buildPostAuthRedirect.mockImplementation(async (args: { returnTo: string }) => `EXCHANGE(${args.returnTo})`);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("joinWithCodeAction", () => {
  it("refuses a malformed submit before counting or reading anything", async () => {
    expect(await joinWithCodeAction({ ...VALID, code: "nope" })).toEqual({
      error: "join.errors.codeInvalid",
      field: "code",
    });
    expect(await joinWithCodeAction({ ...VALID, email: "not-an-email" })).toEqual({
      error: "auth.errors.emailInvalid",
      field: "email",
    });
    expect(await joinWithCodeAction({ ...VALID, password: "short" })).toEqual({
      error: "auth.errors.passwordMin",
      field: "password",
    });
    expect(await joinWithCodeAction({ ...VALID, subdomain: "admin" })).toEqual({
      error: "funds.create.errors.subdomainReserved",
      field: "subdomain",
    });
    expect(allowJoinSubmit).not.toHaveBeenCalled();
    expect(prisma.subscriptionWaiverCode.findUnique).not.toHaveBeenCalled();
  });

  it("refuses when the attempt limits say so, before any read", async () => {
    allowJoinSubmit.mockResolvedValue(false);
    expect(await joinWithCodeAction(VALID)).toEqual({ error: "join.errors.tooMany" });
    expect(allowJoinSubmit).toHaveBeenCalledWith("7K3PM2QX9RTD");
    expect(prisma.subscriptionWaiverCode.findUnique).not.toHaveBeenCalled();
  });

  it("gives one answer for an unknown, revoked, expired or used-up code", async () => {
    for (const row of [
      null,
      { ...activeCode, revokedAt: new Date() },
      { ...activeCode, expiresAt: new Date(Date.now() - 1000) },
      { ...activeCode, usedCount: 1 },
    ]) {
      prisma.subscriptionWaiverCode.findUnique.mockResolvedValueOnce(row);
      expect(await joinWithCodeAction(VALID)).toEqual({
        error: "join.errors.codeInvalid",
        field: "code",
      });
    }
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("tells an existing account to sign in, pointing at /new with the code", async () => {
    prisma.user.findFirst.mockResolvedValue({ id: "user-0" });
    expect(await joinWithCodeAction(VALID)).toEqual({
      error: "join.errors.accountExists",
      field: "email",
      signInUrl: SIGN_IN_URL,
    });
    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: { email: { equals: "alice@example.org", mode: "insensitive" } },
      select: { id: true },
    });
    expect(transaction).not.toHaveBeenCalled();
  });

  it("claims a use, creates the account and the fund waived in one transaction, then hands over", async () => {
    const result = await joinWithCodeAction(VALID);

    expect(result).toEqual({ ok: true, redirectTo: "EXCHANGE(http://laclass.localhost:3000/dashboard)" });
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(tx.subscriptionWaiverCode.updateMany).toHaveBeenCalledWith({
      where: {
        id: "code-1",
        revokedAt: null,
        usedCount: { lt: 1 },
        OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
      },
      data: { usedCount: { increment: 1 } },
    });
    expect(tx.user.create).toHaveBeenCalledWith({
      data: { email: "alice@example.org", name: "alice", emailVerified: false },
      select: { id: true },
    });
    expect(tx.account.create).toHaveBeenCalledWith({
      data: {
        userId: "user-1",
        providerId: "credential",
        accountId: "user-1",
        password: "hashed:correct horse",
      },
    });
    expect(tx.fund.create).toHaveBeenCalledTimes(1);
    const data = tx.fund.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      name: "La Class",
      domain: "laclass.lacaisse.eu",
      defaultLocale: "fr",
      tokenMinterPrivateKeyEnc: "v2:enc",
      tokenMinterEoaAddress: "0xEOA",
      staff: { create: { userId: "user-1", role: "OWNER" } },
      subscriptionWaivedAt: expect.any(Date),
      subscriptionWaiverReason: "Contributor: Alice",
      subscriptionWaiverCodeId: "code-1",
      createdWithWaiverCodeId: "code-1",
    });
    expect(data.tiers.create.name).toBe("Standard");

    // The claim and the waiver share one clock.
    const claimedAt = tx.subscriptionWaiverCode.updateMany.mock.calls[0][0].where.OR[1].expiresAt.gt;
    expect(data.subscriptionWaivedAt).toEqual(claimedAt);

    expect(registerFundMcpResource).toHaveBeenCalledWith({
      id: "fund-1",
      name: "La Class",
      domain: "laclass.lacaisse.eu",
    });
    expect(signInEmail).toHaveBeenCalledWith({
      body: { email: "alice@example.org", password: "correct horse" },
      headers: expect.any(Headers),
    });
    expect(buildPostAuthRedirect).toHaveBeenCalledWith({
      userId: "user-1",
      email: "alice@example.org",
      returnTo: "http://laclass.localhost:3000/dashboard",
    });
    expect(revalidatePath).toHaveBeenCalledWith("/admin/waivers");
  });

  it("answers like a wrong code when the code's last use went to someone else meanwhile", async () => {
    tx.subscriptionWaiverCode.updateMany.mockResolvedValue({ count: 0 });
    expect(await joinWithCodeAction(VALID)).toEqual({
      error: "join.errors.codeInvalid",
      field: "code",
    });
    expect(tx.user.create).not.toHaveBeenCalled();
    expect(tx.fund.create).not.toHaveBeenCalled();
    expect(signInEmail).not.toHaveBeenCalled();
  });

  it("tells the person to sign in when the email got an account meanwhile (the claim rolls back)", async () => {
    tx.user.create.mockRejectedValue(uniqueViolation(["email"]));
    expect(await joinWithCodeAction(VALID)).toEqual({
      error: "join.errors.accountExists",
      field: "email",
      signInUrl: SIGN_IN_URL,
    });
    // The real $transaction rolls the claimed use back with the throw; here
    // the mock surfaces it as the rejection the action catches.
    expect(tx.fund.create).not.toHaveBeenCalled();
    expect(signInEmail).not.toHaveBeenCalled();
  });

  it("names the subdomain when it got taken meanwhile (the claim and the account roll back)", async () => {
    tx.fund.create.mockRejectedValue(uniqueViolation(["domain"]));
    expect(await joinWithCodeAction(VALID)).toEqual({
      error: "funds.create.errors.subdomainTaken",
      field: "subdomain",
    });
    expect(signInEmail).not.toHaveBeenCalled();
    expect(buildPostAuthRedirect).not.toHaveBeenCalled();
  });

  it("lets any other failure surface", async () => {
    tx.fund.create.mockRejectedValue(new Error("connection reset"));
    await expect(joinWithCodeAction(VALID)).rejects.toThrow("connection reset");
  });

  it("still hands over when the apex sign-in fails — the exchange carries the identity", async () => {
    signInEmail.mockRejectedValue(new APIError("UNAUTHORIZED", { message: "nope" }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await joinWithCodeAction(VALID)).toEqual({
      ok: true,
      redirectTo: "EXCHANGE(http://laclass.localhost:3000/dashboard)",
    });
    expect(error).toHaveBeenCalled();
  });
});
