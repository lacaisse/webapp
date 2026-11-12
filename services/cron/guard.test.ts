// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

import { cronGate } from "./guard";

const req = (auth?: string) =>
  new NextRequest("https://lacaisse.eu/api/cron/topups", {
    headers: auth ? { authorization: auth } : {},
  });

afterEach(() => {
  vi.unstubAllEnvs();
});

function env(vars: Record<string, string | undefined>) {
  for (const name of ["VERCEL_ENV", "DEPLOY_TARGET", "CRON_ALLOW_NONPROD", "CRON_SECRET"]) {
    vi.stubEnv(name, vars[name] ?? "");
  }
}

describe("cronGate on Vercel (unchanged)", () => {
  it("skips outside production", async () => {
    env({ VERCEL_ENV: "preview", CRON_SECRET: "s" });
    const res = cronGate(req("Bearer s"));
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({ skipped: "non-production" });
  });

  it("503 in production without a secret", () => {
    env({ VERCEL_ENV: "production" });
    expect(cronGate(req())?.status).toBe(503);
  });

  it("401 on a wrong bearer, passes on the right one", () => {
    env({ VERCEL_ENV: "production", CRON_SECRET: "s" });
    expect(cronGate(req("Bearer x"))?.status).toBe(401);
    expect(cronGate(req())?.status).toBe(401);
    expect(cronGate(req("Bearer s"))).toBeNull();
  });

  it("CRON_ALLOW_NONPROD without a secret lets a local call through", () => {
    env({ CRON_ALLOW_NONPROD: "true" });
    expect(cronGate(req())).toBeNull();
  });
});

describe("cronGate in the container image (DEPLOY_TARGET=container)", () => {
  it("counts as production: the secret is mandatory", () => {
    env({ DEPLOY_TARGET: "container" });
    expect(cronGate(req())?.status).toBe(503);
  });

  it("checks the bearer", () => {
    env({ DEPLOY_TARGET: "container", CRON_SECRET: "s" });
    expect(cronGate(req("Bearer x"))?.status).toBe(401);
    expect(cronGate(req("Bearer s"))).toBeNull();
  });

  it("any other DEPLOY_TARGET value is not production", async () => {
    env({ DEPLOY_TARGET: "vercel", CRON_SECRET: "s" });
    expect(await cronGate(req("Bearer s"))?.json()).toEqual({ skipped: "non-production" });
  });
});
