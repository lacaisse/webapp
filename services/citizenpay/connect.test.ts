// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Prisma is stubbed per test; `fetch` (CP's pickup) is faked; the
// side-effect helpers consumeConnect calls after a pickup are stubbed out.
vi.mock("server-only", () => ({}));
const prisma = vi.hoisted(() => ({
  citizenPayConnectAttempt: {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
  },
  fund: { findUnique: vi.fn(), update: vi.fn() },
  fundTokenAccount: { upsert: vi.fn() },
  $transaction: vi.fn(async () => []),
}));
vi.mock("@/services/db/prisma", () => ({ prisma }));
vi.mock("@/services/crypto/secret", () => ({ encryptSecret: (s: string) => `enc:${s}` }));
const deriveSmartAccountAddress = vi.hoisted(() => vi.fn(async (): Promise<string | null> => null));
vi.mock("@/services/token/smart-account", () => ({ deriveSmartAccountAddress }));
const fetchTokenInfo = vi.hoisted(() => vi.fn(async (): Promise<unknown> => null));
vi.mock("./sync", () => ({ fetchTokenInfo }));
const schedule = vi.hoisted(() => vi.fn());
vi.mock("./sync-top-up-url", () => ({ scheduleTreasuryTopUpUrlSync: schedule }));
const scheduleRoles = vi.hoisted(() => vi.fn());
vi.mock("./token-roles", () => ({ scheduleEnsureMinterRoles: scheduleRoles }));

import {
  cancelPendingRegistration,
  ConnectError,
  consumeConnect,
  initiateTreasuryRegistration,
  resumeTreasuryRegistration,
} from "./connect";

const T0 = new Date("2026-10-20T10:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  process.env.CITIZENPAY_API_BASE_URL = "https://cp.test";
  process.env.APP_DOMAIN = "lacaisse.eu";
  vi.stubEnv("NODE_ENV", "production");
  for (const table of Object.values(prisma)) {
    if (typeof table === "object") for (const fn of Object.values(table)) fn.mockReset();
  }
  prisma.$transaction.mockResolvedValue([]);
  schedule.mockReset();
  scheduleRoles.mockReset();
  deriveSmartAccountAddress.mockReset();
  deriveSmartAccountAddress.mockResolvedValue(null);
  fetchTokenInfo.mockReset();
  fetchTokenInfo.mockResolvedValue(null);
  prisma.citizenPayConnectAttempt.create.mockImplementation(async ({ data }) => data);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ConnectError) return e.code;
    throw e;
  }
  throw new Error("expected a ConnectError");
}

describe("initiateTreasuryRegistration", () => {
  it("refuses while an unconsumed, unexpired attempt exists for the fund", async () => {
    prisma.citizenPayConnectAttempt.findFirst.mockResolvedValue({ state: "a1" });
    await expect(
      code(
        initiateTreasuryRegistration({
          fundId: "f1",
          returnHost: "acme.lacaisse.eu",
          prefill: { name: "Acme" },
        }),
      ),
    ).resolves.toBe("registration_pending");
    expect(prisma.citizenPayConnectAttempt.findFirst).toHaveBeenCalledWith({
      where: { fundId: "f1", consumedAt: null, expiresAt: { gt: T0 } },
      select: { state: true },
    });
    expect(prisma.citizenPayConnectAttempt.create).not.toHaveBeenCalled();
  });

  it("otherwise mints a 30-minute fund state and builds the CP URL", async () => {
    prisma.citizenPayConnectAttempt.findFirst.mockResolvedValue(null);
    const { redirectUrl } = await initiateTreasuryRegistration({
      fundId: "f1",
      returnHost: "acme.lacaisse.eu",
      prefill: { name: "Acme", symbol: "acme", keyName: "La Caisse — initial 2026-10-20" },
    });
    const created = prisma.citizenPayConnectAttempt.create.mock.calls[0][0].data;
    expect(created).toMatchObject({ fundId: "f1", returnHost: "acme.lacaisse.eu" });
    expect(created.expiresAt).toEqual(new Date(T0.getTime() + 30 * 60 * 1000));

    const url = new URL(redirectUrl);
    expect(url.origin + url.pathname).toBe("https://cp.test/v2/treasury/register");
    expect(url.searchParams.get("redirect_uri")).toBe(
      `https://acme.lacaisse.eu/api/citizenpay/callback/${encodeURIComponent(created.state)}`,
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      name: "Acme",
      symbol: "ACME",
      decimals: "6",
      chain: "100",
      key_name: "La Caisse — initial 2026-10-20",
    });
  });
});

// Back (or a closed tab) during the CP form leaves the attempt open for 30
// minutes. "Resume" sends the admin back to CP with the *same* fund state —
// no new row, so there is still exactly one state CP can land on.
describe("resumeTreasuryRegistration", () => {
  const args = {
    fundId: "f1",
    returnHost: "acme.lacaisse.eu",
    prefill: { name: "Acme", symbol: "acme", keyName: "La Caisse — initial 2026-10-20" },
  };

  it("rebuilds the CP URL for the pending fund state without minting a new one", async () => {
    prisma.citizenPayConnectAttempt.findFirst.mockResolvedValue({ state: "pending-1" });
    const { redirectUrl } = await resumeTreasuryRegistration(args);
    expect(prisma.citizenPayConnectAttempt.findFirst).toHaveBeenCalledWith({
      where: { fundId: "f1", consumedAt: null, expiresAt: { gt: T0 } },
      select: { state: true },
    });
    expect(prisma.citizenPayConnectAttempt.create).not.toHaveBeenCalled();

    const url = new URL(redirectUrl);
    expect(url.origin + url.pathname).toBe("https://cp.test/v2/treasury/register");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://acme.lacaisse.eu/api/citizenpay/callback/pending-1",
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      name: "Acme",
      symbol: "ACME",
      decimals: "6",
      chain: "100",
      key_name: "La Caisse — initial 2026-10-20",
    });
  });

  it("hands CP the same URL a fresh start would, apart from the state", async () => {
    prisma.citizenPayConnectAttempt.findFirst.mockResolvedValue(null);
    const fresh = new URL((await initiateTreasuryRegistration(args)).redirectUrl);
    const minted = prisma.citizenPayConnectAttempt.create.mock.calls[0][0].data.state;

    prisma.citizenPayConnectAttempt.findFirst.mockResolvedValue({ state: minted });
    const resumed = new URL((await resumeTreasuryRegistration(args)).redirectUrl);
    expect(resumed.toString()).toBe(fresh.toString());
  });

  it("refuses when nothing is pending (consumed or expired meanwhile)", async () => {
    prisma.citizenPayConnectAttempt.findFirst.mockResolvedValue(null);
    await expect(code(resumeTreasuryRegistration(args))).resolves.toBe(
      "no_pending_registration",
    );
    expect(prisma.citizenPayConnectAttempt.create).not.toHaveBeenCalled();
  });
});

// "Start over" expires the pending attempts so a new registration can start
// right away; a CP tab still open on the old form then fails at the callback.
describe("cancelPendingRegistration", () => {
  it("expires the fund's pending attempts as of now and reports how many", async () => {
    prisma.citizenPayConnectAttempt.updateMany.mockResolvedValue({ count: 1 });
    await expect(cancelPendingRegistration("f1")).resolves.toBe(1);
    expect(prisma.citizenPayConnectAttempt.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { fundId: "f1", consumedAt: null, expiresAt: { gt: T0 } },
      data: { expiresAt: T0 },
    });
  });

  it("lets a new registration start, and the old state is rejected as expired", async () => {
    // Before: one open attempt → a fresh start is refused.
    const old = {
      state: "old",
      fundId: "f1",
      returnHost: "acme.lacaisse.eu",
      consumedAt: null,
      expiresAt: new Date(T0.getTime() + 10 * 60 * 1000),
    };
    prisma.citizenPayConnectAttempt.findFirst.mockResolvedValue({ state: old.state });
    const args = { fundId: "f1", returnHost: "acme.lacaisse.eu", prefill: { name: "Acme" } };
    await expect(code(initiateTreasuryRegistration(args))).resolves.toBe("registration_pending");

    // Cancel: the row's expiresAt becomes "now", so the pending query (gt now)
    // no longer finds it...
    prisma.citizenPayConnectAttempt.updateMany.mockImplementation(async ({ data }) => {
      old.expiresAt = data.expiresAt;
      return { count: 1 };
    });
    await cancelPendingRegistration("f1");
    expect(old.expiresAt).toEqual(T0);
    prisma.citizenPayConnectAttempt.findFirst.mockResolvedValue(null);

    // ...a new registration mints a different state...
    const { redirectUrl } = await initiateTreasuryRegistration(args);
    const minted = prisma.citizenPayConnectAttempt.create.mock.calls[0][0].data.state;
    expect(minted).not.toBe("old");
    expect(redirectUrl).toContain(encodeURIComponent(`/callback/${minted}`));

    // ...and the stale CP tab coming back a moment later on the old state is
    // refused before any pickup happens.
    vi.setSystemTime(new Date(T0.getTime() + 1000));
    prisma.citizenPayConnectAttempt.findUnique.mockResolvedValue(old);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await expect(
      code(
        consumeConnect({
          fundState: "old",
          cpState: "cp",
          pickupToken: "pt",
          callbackHost: "acme.lacaisse.eu",
        }),
      ),
    ).resolves.toBe("state_expired");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("consumeConnect — treasury mismatch", () => {
  const attempt = {
    state: "fs",
    fundId: "f1",
    returnHost: "acme.lacaisse.eu",
    consumedAt: null,
    expiresAt: new Date(T0.getTime() + 60_000),
  };
  const pickup = (treasury_id: string) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ treasury_id, api_key_id: "0xkey", api_key: "secret" }),
      ),
    );
  const call = () =>
    consumeConnect({
      fundState: "fs",
      cpState: "cp",
      pickupToken: "pt",
      callbackHost: "acme.lacaisse.eu",
    });

  it("refuses a pickup for a different treasury than the one on the fund", async () => {
    prisma.citizenPayConnectAttempt.findUnique.mockResolvedValue(attempt);
    prisma.fund.findUnique.mockResolvedValue({ citizenPayFundId: "t-old" });
    pickup("t-new");
    await expect(code(call())).resolves.toBe("treasury_mismatch");
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("accepts the same treasury (key rotation) and a fund with none yet (Flow 1)", async () => {
    prisma.citizenPayConnectAttempt.findUnique.mockResolvedValue(attempt);
    prisma.fund.findUnique.mockResolvedValue({ citizenPayFundId: "t-1" });
    pickup("t-1");
    await expect(call()).resolves.toEqual({ treasuryId: "t-1", apiKeyId: "0xkey" });

    prisma.fund.findUnique.mockResolvedValue({ citizenPayFundId: null });
    pickup("t-2");
    await expect(call()).resolves.toEqual({ treasuryId: "t-2", apiKeyId: "0xkey" });
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
  });
});

// Top-up URL wiring: once the credentials transaction commits, the fund row
// it returned is handed to the deferred top-up sync — no extra read after the
// commit that could fail a connect that already succeeded. Flow 1 and Flow 2
// both finish in consumeConnect, so both publish the link.
describe("consumeConnect — top-up URL", () => {
  const attempt = {
    state: "fs",
    fundId: "f1",
    returnHost: "laclass.lacaisse.eu",
    consumedAt: null,
    expiresAt: new Date(T0.getTime() + 60_000),
  };
  const connectedFund = {
    id: "f1",
    domain: "laclass.lacaisse.eu",
    allocationMode: "PAY_AND_GO",
    citizenPayApiKeyId: "0xkey",
    citizenPayApiKeyEnc: "enc:secret",
  };
  const call = () =>
    consumeConnect({
      fundState: "fs",
      cpState: "cs",
      pickupToken: "pt",
      callbackHost: "laclass.lacaisse.eu",
    });

  beforeEach(() => {
    prisma.citizenPayConnectAttempt.findUnique.mockResolvedValue(attempt);
    prisma.$transaction.mockResolvedValue([connectedFund, {}] as never);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ api_key: "secret", api_key_id: "0xkey", treasury_id: "t-1" }),
      ),
    );
  });

  it.each([
    ["Flow 1 (no treasury on the fund yet)", null],
    ["Flow 2 (key for the fund's treasury)", "t-1"],
  ])("schedules the sync with the committed row — %s", async (_flow, citizenPayFundId) => {
    prisma.fund.findUnique.mockResolvedValue({ citizenPayFundId });
    await expect(call()).resolves.toEqual({ treasuryId: "t-1", apiKeyId: "0xkey" });
    expect(schedule).toHaveBeenCalledExactlyOnceWith(connectedFund);
    // Only the pre-transaction read (treasury check + fee/minter fields).
    expect(prisma.fund.findUnique).toHaveBeenCalledOnce();
  });

  it("doesn't schedule anything when the connect is refused", async () => {
    prisma.fund.findUnique.mockResolvedValue({ citizenPayFundId: "t-other" });
    await expect(code(call())).resolves.toBe("treasury_mismatch");
    expect(schedule).not.toHaveBeenCalled();
  });
});

// Minter-role grant: once the Safe is derived and the token is known, the
// connect asks CP (deferred, best-effort) to grant the Safe its roles.
describe("consumeConnect — minter roles", () => {
  const attempt = {
    state: "fs",
    fundId: "f1",
    returnHost: "demo.lacaisse.eu",
    consumedAt: null,
    expiresAt: new Date(T0.getTime() + 60_000),
  };
  const SAFE = "0x15fbD78d29AcC4dA1E9630caDE532eDBCab4BB23";
  const TOKEN = "0x1356E5C3e7FB6a6Cf821D844ea826a75B5D39422";
  const call = () =>
    consumeConnect({
      fundState: "fs",
      cpState: "cs",
      pickupToken: "pt",
      callbackHost: "demo.lacaisse.eu",
    });

  beforeEach(() => {
    prisma.citizenPayConnectAttempt.findUnique.mockResolvedValue(attempt);
    prisma.fund.findUnique.mockResolvedValue({
      citizenPayFundId: null,
      tokenMinterEoaAddress: "0xeoa",
    });
    fetchTokenInfo.mockResolvedValue({
      tokenAddress: TOKEN,
      citizenPayAccountFactoryAddress: "0xfactory",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ api_key: "secret", api_key_id: "0xkey", treasury_id: "t-1" }),
      ),
    );
  });

  it("schedules the grant when the Safe and the token are known", async () => {
    deriveSmartAccountAddress.mockResolvedValue(SAFE);
    prisma.$transaction.mockResolvedValue([{ id: "f1", tokenAddress: TOKEN }, {}] as never);
    await call();
    expect(scheduleRoles).toHaveBeenCalledExactlyOnceWith("f1");
  });

  it("skips it without a derived Safe", async () => {
    prisma.$transaction.mockResolvedValue([{ id: "f1", tokenAddress: TOKEN }, {}] as never);
    await call();
    expect(scheduleRoles).not.toHaveBeenCalled();
  });

  it("skips it without a token address", async () => {
    deriveSmartAccountAddress.mockResolvedValue(SAFE);
    prisma.$transaction.mockResolvedValue([{ id: "f1", tokenAddress: null }, {}] as never);
    await call();
    expect(scheduleRoles).not.toHaveBeenCalled();
  });

  it("doesn't fail the connect when scheduling throws", async () => {
    deriveSmartAccountAddress.mockResolvedValue(SAFE);
    prisma.$transaction.mockResolvedValue([{ id: "f1", tokenAddress: TOKEN }, {}] as never);
    scheduleRoles.mockImplementation(() => {
      throw new Error("boom");
    });
    await expect(call()).resolves.toEqual({ treasuryId: "t-1", apiKeyId: "0xkey" });
  });
});
