// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ensureMinterRoles' status mapping, against the real api.ts wrapper with a
// faked fetch (so the wire path + body are pinned too). Prisma is stubbed;
// the on-chain read (permissions.ts) is stubbed for checkAndRecordMinterRole.
vi.mock("server-only", () => ({}));
const prisma = vi.hoisted(() => ({
  fund: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
}));
vi.mock("@/services/db/prisma", () => ({ prisma }));
const checkMinterRole = vi.hoisted(() => vi.fn());
vi.mock("@/services/token/permissions", () => ({ checkMinterRole }));
const afterCallbacks = vi.hoisted(() => [] as Array<() => Promise<void>>);
vi.mock("next/server", () => ({
  after: (cb: () => Promise<void>) => afterCallbacks.push(cb),
}));

import { encryptSecret } from "@/services/crypto/secret";

import {
  CITIZEN_PAY_VIRTUAL_CHAIN_ID,
  checkAndRecordMinterRole,
  ensureMinterRoles,
  scheduleEnsureMinterRoles,
} from "./token-roles";

const SAFE = "0x15fbD78d29AcC4dA1E9630caDE532eDBCab4BB23";
const TOKEN = "0x1356E5C3e7FB6a6Cf821D844ea826a75B5D39422";
const T0 = new Date("2026-10-21T12:00:00Z");

const roles = (over: Record<string, unknown> = {}) => ({
  account: SAFE,
  admin_account: "0xadmin",
  can_grant: true,
  minter: true,
  burner: true,
  separate_burner_role: false,
  granted: [],
  user_op_hashes: [],
  ...over,
});

type FetchCall = [string, RequestInit];
let fetchMock: ReturnType<typeof vi.fn>;
const answer = (status: number, body: unknown) => {
  fetchMock = vi.fn(async () => Response.json(body, { status }));
  vi.stubGlobal("fetch", fetchMock);
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  vi.stubEnv("APP_CRED_KEY", "33".repeat(32));
  vi.stubEnv("CITIZENPAY_API_BASE_URL", "https://cp.test");
  prisma.fund.findUnique.mockReset();
  prisma.fund.update.mockReset();
  prisma.fund.updateMany.mockReset();
  checkMinterRole.mockReset();
  afterCallbacks.length = 0;
  prisma.fund.findUnique.mockResolvedValue({
    id: "f1",
    citizenPayApiKeyId: "0xkey",
    citizenPayApiKeyEnc: encryptSecret("secret"),
    tokenMinterSmartAccountAddress: SAFE,
    tokenAddress: TOKEN,
    tokenChainId: 100,
  });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("ensureMinterRoles", () => {
  it("POSTs minter+burner for the Safe and stamps tokenMintEnabledAt on a grant", async () => {
    answer(200, roles({ granted: ["minter"], user_op_hashes: ["0xop"] }));
    await expect(ensureMinterRoles({ fundId: "f1" })).resolves.toEqual({ status: "granted" });

    const [url, init] = fetchMock.mock.calls[0] as FetchCall;
    expect(url).toBe("https://cp.test/v2/treasury/token/roles");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ account: SAFE, roles: ["minter", "burner"] });
    expect((init.headers as Record<string, string>)["x-api-key-id"]).toBe("0xkey");
    expect((init.headers as Record<string, string>)["x-api-key"]).toBe("secret");
    expect(prisma.fund.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: "f1" },
      data: { tokenMintEnabledAt: T0 },
    });
  });

  it("reports already when nothing was granted, and still stamps", async () => {
    answer(200, roles());
    await expect(ensureMinterRoles({ fundId: "f1" })).resolves.toEqual({ status: "already" });
    expect(prisma.fund.update).toHaveBeenCalledOnce();
  });

  it("fails a 200 whose minter role doesn't read back, without stamping", async () => {
    answer(200, roles({ minter: false }));
    const res = await ensureMinterRoles({ fundId: "f1" });
    expect(res.status).toBe("failed");
    expect(prisma.fund.update).not.toHaveBeenCalled();
  });

  it("keeps a landed grant as granted when the stamp write fails", async () => {
    answer(200, roles({ granted: ["minter"] }));
    prisma.fund.update.mockRejectedValue(new Error("db down"));
    await expect(ensureMinterRoles({ fundId: "f1" })).resolves.toEqual({ status: "granted" });
  });

  it.each([
    [404, "not found"],
    [409, "api is not admin of this token"],
    [422, "virtual-chain treasury"],
  ])("maps %i to unsupported with CP's message", async (status, error) => {
    answer(status, { error });
    await expect(ensureMinterRoles({ fundId: "f1" })).resolves.toEqual({
      status: "unsupported",
      detail: error,
    });
    expect(prisma.fund.update).not.toHaveBeenCalled();
  });

  it.each([
    [429, "daily cap reached"],
    [502, "grant bundle failed"],
    [500, "boom"],
  ])("maps %i to failed with CP's message", async (status, error) => {
    answer(status, { error });
    await expect(ensureMinterRoles({ fundId: "f1" })).resolves.toEqual({
      status: "failed",
      detail: error,
    });
  });

  it("maps a network error to failed and never throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    await expect(ensureMinterRoles({ fundId: "f1" })).resolves.toEqual({
      status: "failed",
      detail: "fetch failed",
    });
  });

  it("maps a Prisma failure to failed and never throws", async () => {
    prisma.fund.findUnique.mockRejectedValue(new Error("db down"));
    await expect(ensureMinterRoles({ fundId: "f1" })).resolves.toEqual({
      status: "failed",
      detail: "db down",
    });
  });

  it.each([
    ["no Safe", { tokenMinterSmartAccountAddress: null }],
    ["no token", { tokenAddress: null }],
    ["the virtual chain", { tokenChainId: CITIZEN_PAY_VIRTUAL_CHAIN_ID }],
    ["no credentials", { citizenPayApiKeyEnc: null }],
  ])("is unsupported without calling CP — %s", async (_case, over) => {
    prisma.fund.findUnique.mockResolvedValue({
      id: "f1",
      citizenPayApiKeyId: "0xkey",
      citizenPayApiKeyEnc: encryptSecret("secret"),
      tokenMinterSmartAccountAddress: SAFE,
      tokenAddress: TOKEN,
      tokenChainId: 100,
      ...over,
    });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await ensureMinterRoles({ fundId: "f1" });
    expect(res.status).toBe("unsupported");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("is unsupported in mock mode (no CP base URL)", async () => {
    vi.stubEnv("CITIZENPAY_API_BASE_URL", "");
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const res = await ensureMinterRoles({ fundId: "f1" });
    expect(res.status).toBe("unsupported");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(prisma.fund.findUnique).not.toHaveBeenCalled();
  });
});

describe("scheduleEnsureMinterRoles", () => {
  it("defers the grant to after()", async () => {
    answer(200, roles());
    scheduleEnsureMinterRoles("f1");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(1);
    await afterCallbacks[0]();
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe("checkAndRecordMinterRole", () => {
  const args = {
    fundId: "f1",
    tokenAddress: TOKEN,
    chainId: 100,
    account: SAFE,
  };

  it("stamps tokenMintEnabledAt when the role is on chain and the column is null", async () => {
    checkMinterRole.mockResolvedValue("has-role");
    await expect(checkAndRecordMinterRole({ ...args, mintEnabledAt: null })).resolves.toBe(
      "has-role",
    );
    expect(prisma.fund.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { id: "f1", tokenMintEnabledAt: null },
      data: { tokenMintEnabledAt: T0 },
    });
  });

  it("leaves an existing stamp alone", async () => {
    checkMinterRole.mockResolvedValue("has-role");
    await checkAndRecordMinterRole({ ...args, mintEnabledAt: new Date("2026-10-01") });
    expect(prisma.fund.updateMany).not.toHaveBeenCalled();
  });

  it.each(["missing-role", "unknown"])("doesn't stamp on %s", async (status) => {
    checkMinterRole.mockResolvedValue(status);
    await expect(checkAndRecordMinterRole({ ...args, mintEnabledAt: null })).resolves.toBe(status);
    expect(prisma.fund.updateMany).not.toHaveBeenCalled();
  });

  it("still returns the status when the stamp fails", async () => {
    checkMinterRole.mockResolvedValue("has-role");
    prisma.fund.updateMany.mockRejectedValue(new Error("db down"));
    await expect(checkAndRecordMinterRole({ ...args, mintEnabledAt: null })).resolves.toBe(
      "has-role",
    );
  });
});
