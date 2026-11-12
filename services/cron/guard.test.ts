// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

import { bearerMatches, cronGate } from "./guard";

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

// The decision table, every combination of environment and header. The
// constant-time comparison must not change a single cell.
describe("cronGate decision table", () => {
  const envs = {
    "vercel-production": { VERCEL_ENV: "production" },
    "vercel-preview": { VERCEL_ENV: "preview" },
    container: { DEPLOY_TARGET: "container" },
    "local-allow": { CRON_ALLOW_NONPROD: "true" },
    none: {},
  } as const;
  const secrets = { "secret set": "s3cret", "secret unset": undefined } as const;
  const headers = {
    right: "Bearer s3cret",
    wrong: "Bearer nope",
    "wrong length": "Bearer s3cret-and-more",
    "no Bearer prefix": "s3cret",
    "lower-case bearer": "bearer s3cret",
    missing: undefined,
  } as const;

  function expected(envName: keyof typeof envs, secret: string | undefined, header: string | undefined) {
    const production = envName === "vercel-production" || envName === "container";
    if (!production && envName !== "local-allow") return "skipped";
    if (!secret && production) return 503;
    if (secret && header !== `Bearer ${secret}`) return 401;
    return "pass";
  }

  for (const [envName, vars] of Object.entries(envs)) {
    for (const [secretName, secret] of Object.entries(secrets)) {
      for (const [headerName, header] of Object.entries(headers)) {
        it(`${envName}, ${secretName}, ${headerName} header`, async () => {
          env({ ...vars, CRON_SECRET: secret });
          const res = cronGate(req(header));
          const want = expected(envName as keyof typeof envs, secret, header);
          if (want === "pass") expect(res).toBeNull();
          else if (want === "skipped") expect(await res?.json()).toEqual({ skipped: "non-production" });
          else expect(res?.status).toBe(want);
        });
      }
    }
  }
});

describe("bearerMatches", () => {
  it("matches only the exact header", () => {
    expect(bearerMatches("Bearer abc", "abc")).toBe(true);
    expect(bearerMatches("Bearer abd", "abc")).toBe(false);
    expect(bearerMatches("Bearer abc ", "abc")).toBe(false);
    expect(bearerMatches("Bearer ab", "abc")).toBe(false);
    expect(bearerMatches(null, "abc")).toBe(false);
    expect(bearerMatches("", "abc")).toBe(false);
  });
});
