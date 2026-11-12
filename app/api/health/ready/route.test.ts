// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  connection: vi.fn(async () => undefined),
}));
// The probe itself (its own bounded pg connection) is stubbed; this file
// checks the route and the sharing / deadline logic around it.
const { probe } = vi.hoisted(() => ({ probe: { selectOne: vi.fn() } }));
vi.mock("@/services/db/health-probe", () => probe);
const prisma = { $queryRaw: probe.selectOne };

import { GET } from "./route";
import { GET as LIVE } from "../route";

beforeEach(() => {
  vi.stubEnv("DEPLOY_TARGET", "container");
  prisma.$queryRaw.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("GET /api/health", () => {
  it("answers without the database", async () => {
    vi.stubEnv("DEPLOY_TARGET", "");
    const res = await LIVE();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});

describe("GET /api/health/ready", () => {
  it("200 when SELECT 1 answers", async () => {
    prisma.$queryRaw.mockResolvedValue([{ "?column?": 1 }]);
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("503 when the query fails", async () => {
    prisma.$queryRaw.mockRejectedValue(new Error("connection refused"));
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false });
  });

  it("503 when the database does not answer within 2 s", async () => {
    vi.useFakeTimers();
    let release!: (v: unknown) => void;
    prisma.$queryRaw.mockReturnValue(new Promise((r) => (release = r)));
    const pending = GET();
    await vi.advanceTimersByTimeAsync(2_000);
    const res = await pending;
    expect(res.status).toBe(503);
    // Let the shared probe settle so the next test starts clean.
    release([]);
    await vi.advanceTimersByTimeAsync(0);
  });

  it("shares one probe between concurrent checks", async () => {
    vi.useFakeTimers();
    let release!: (v: unknown) => void;
    prisma.$queryRaw.mockReturnValue(new Promise((r) => (release = r)));
    const calls = [GET(), GET(), GET()];
    release(undefined);
    for (const res of await Promise.all(calls)) expect(res.status).toBe(200);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("after a probe that never settles, the next check starts a fresh one and can answer 200", async () => {
    vi.useFakeTimers();
    prisma.$queryRaw.mockReturnValueOnce(new Promise(() => {})); // never settles
    const first = GET();
    await vi.advanceTimersByTimeAsync(2_000);
    expect((await first).status).toBe(503);

    prisma.$queryRaw.mockResolvedValueOnce(undefined); // the database is back
    expect((await GET()).status).toBe(200);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it("is an empty 404 outside the container image", async () => {
    vi.stubEnv("DEPLOY_TARGET", "");
    const res = await GET();
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});
