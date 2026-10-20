// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// The DAL and the host lookup are stubbed; connect.ts runs for real on a
// stubbed Prisma so the happy path asserts the CP URL it actually builds.
vi.mock("server-only", () => ({}));
const { prisma, fund } = vi.hoisted(() => ({
  prisma: { citizenPayConnectAttempt: { findFirst: vi.fn(), create: vi.fn() } },
  fund: {
    id: "f1",
    name: "Acme",
    tokenName: null as string | null,
    tokenSymbol: "acme" as string | null,
    citizenPayFundId: null as string | null,
  },
}));
vi.mock("@/services/db/prisma", () => ({ prisma }));
vi.mock("@/services/auth/dal", () => ({ requireFundRole: vi.fn(async () => ({ fund })) }));
vi.mock("@/services/fund/server", async () => ({
  ...(await import("@/services/fund/host")),
  getCurrentFundDomain: vi.fn(async () => "acme.lacaisse.eu"),
}));

import { GET } from "./route";

const T0 = new Date("2026-10-20T10:00:00Z");
const req = (headers: Record<string, string> = {}) =>
  new NextRequest("https://acme.lacaisse.eu/api/citizenpay/register", { headers });
const SETTINGS = "https://acme.lacaisse.eu/settings?tab=citizenpay&connect=";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  process.env.CITIZENPAY_API_BASE_URL = "https://cp.test";
  process.env.APP_DOMAIN = "lacaisse.eu";
  vi.stubEnv("NODE_ENV", "production");
  fund.citizenPayFundId = null;
  prisma.citizenPayConnectAttempt.findFirst.mockReset().mockResolvedValue(null);
  prisma.citizenPayConnectAttempt.create
    .mockReset()
    .mockImplementation(async ({ data }) => data);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("GET /api/citizenpay/register", () => {
  it("already_registered when the fund has a treasury id", async () => {
    fund.citizenPayFundId = "t-1";
    const res = await GET(req());
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${SETTINGS}already_registered`);
    expect(prisma.citizenPayConnectAttempt.create).not.toHaveBeenCalled();
  });

  it("registration_pending when an attempt is still open", async () => {
    prisma.citizenPayConnectAttempt.findFirst.mockResolvedValue({ state: "a1" });
    const res = await GET(req());
    expect(res.headers.get("location")).toBe(`${SETTINGS}registration_pending`);
    expect(prisma.citizenPayConnectAttempt.create).not.toHaveBeenCalled();
  });

  it("forbidden on a cross-site navigation, before touching the DB", async () => {
    const res = await GET(req({ "sec-fetch-site": "cross-site" }));
    expect(res.headers.get("location")).toBe(`${SETTINGS}forbidden`);
    expect(prisma.citizenPayConnectAttempt.findFirst).not.toHaveBeenCalled();
  });

  it("not_configured without a CP base URL", async () => {
    delete process.env.CITIZENPAY_API_BASE_URL;
    const res = await GET(req({ "sec-fetch-site": "same-origin" }));
    expect(res.headers.get("location")).toBe(`${SETTINGS}not_configured`);
  });

  it("happy path: mints a fund state and 302s to CP with the prefill", async () => {
    const res = await GET(req({ "sec-fetch-site": "same-origin" }));
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get("location")!);
    expect(url.origin + url.pathname).toBe("https://cp.test/v2/treasury/register");

    const created = prisma.citizenPayConnectAttempt.create.mock.calls[0][0].data;
    expect(created.fundId).toBe("f1");
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
