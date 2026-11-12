// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  connection: vi.fn(async () => undefined),
}));
const { prisma } = vi.hoisted(() => ({
  prisma: { fund: { findUnique: vi.fn() } },
}));
vi.mock("@/services/db/prisma", () => ({ prisma }));

import { GET } from "./route";

const FUNDS = new Set(["alpha.lacaisse.eu", "caisse.example.org"]);

const req = (query: string, auth: string | null = "Bearer test-cron-secret") =>
  new NextRequest(`http://10.0.0.3:3000/api/internal/hostname-allowed${query}`, {
    headers: auth ? { authorization: auth } : {},
  });

beforeEach(() => {
  vi.stubEnv("DEPLOY_TARGET", "container");
  vi.stubEnv("CRON_SECRET", "test-cron-secret");
  vi.stubEnv("APP_DOMAIN", "staging.lacaisse.eu");
  prisma.fund.findUnique.mockReset().mockImplementation(async ({ where }) =>
    FUNDS.has(where.domain) ? { id: "f" } : null,
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("GET /api/internal/hostname-allowed", () => {
  it.each([
    ["staging.lacaisse.eu", 200],
    ["auth.staging.lacaisse.eu", 200],
    ["alpha.staging.lacaisse.eu", 200],
    ["caisse.example.org", 200],
    ["nope.staging.lacaisse.eu", 404],
    ["other.example.org", 404],
    ["www.staging.lacaisse.eu", 404],
    ["alpha.lacaisse.eu", 404],
  ])("%s → %i", async (hostname, status) => {
    const res = await GET(req(`?hostname=${hostname}`));
    expect(res.status).toBe(status);
    expect(await res.text()).toBe("");
  });

  it("does one unique lookup on the canonical domain for a fund subdomain", async () => {
    await GET(req("?hostname=alpha.staging.lacaisse.eu"));
    expect(prisma.fund.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.fund.findUnique).toHaveBeenCalledWith({
      where: { domain: "alpha.lacaisse.eu" },
      select: { id: true },
    });
  });

  it("never touches the database for the apex, the auth host or a denied name", async () => {
    for (const h of ["staging.lacaisse.eu", "auth.staging.lacaisse.eu", "www.staging.lacaisse.eu"]) {
      await GET(req(`?hostname=${h}`));
    }
    expect(prisma.fund.findUnique).not.toHaveBeenCalled();
  });

  it.each(["", "?hostname=", "?hostname=ALPHA.staging.lacaisse.eu", "?hostname=a&hostname=b"])(
    "400 on bad input %j",
    async (query) => {
      const res = await GET(req(query));
      expect(res.status).toBe(400);
      expect(prisma.fund.findUnique).not.toHaveBeenCalled();
    },
  );

  it("401 without the bearer or with a wrong one", async () => {
    expect((await GET(req("?hostname=staging.lacaisse.eu", null))).status).toBe(401);
    expect((await GET(req("?hostname=staging.lacaisse.eu", "Bearer nope"))).status).toBe(401);
  });

  it("503 when no secret is configured", async () => {
    vi.stubEnv("CRON_SECRET", "");
    expect((await GET(req("?hostname=staging.lacaisse.eu"))).status).toBe(503);
  });

  it.each([
    ["unset", {}],
    ["Vercel production", { VERCEL_ENV: "production" }],
    ["Vercel preview", { VERCEL_ENV: "preview" }],
    ["CRON_ALLOW_NONPROD", { CRON_ALLOW_NONPROD: "true" }],
  ])("empty 404 without DEPLOY_TARGET=container (%s), even with the bearer", async (_, vars) => {
    vi.stubEnv("DEPLOY_TARGET", "");
    for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v as string);
    const res = await GET(req("?hostname=staging.lacaisse.eu"));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
    expect(prisma.fund.findUnique).not.toHaveBeenCalled();
  });
});
