// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  connection: vi.fn(async () => undefined),
}));
const { prisma } = vi.hoisted(() => ({ prisma: { $queryRaw: vi.fn() } }));
vi.mock("@/services/db/prisma", () => ({ prisma }));

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

  it("keeps at most one SELECT 1 in flight while the database hangs", async () => {
    vi.useFakeTimers();
    let release!: (v: unknown) => void;
    prisma.$queryRaw.mockReturnValue(new Promise((r) => (release = r)));
    const calls = [GET(), GET(), GET()];
    await vi.advanceTimersByTimeAsync(2_000);
    const later = GET();
    await vi.advanceTimersByTimeAsync(2_000);
    for (const res of await Promise.all([...calls, later])) expect(res.status).toBe(503);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    // Once it settles, the next check runs a fresh query.
    release([{ "?column?": 1 }]);
    await vi.advanceTimersByTimeAsync(0);
    prisma.$queryRaw.mockResolvedValue([{ "?column?": 1 }]);
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
