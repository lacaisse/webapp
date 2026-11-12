// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  prisma.$queryRaw.mockReset();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("GET /api/health", () => {
  it("answers without the database", async () => {
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
    prisma.$queryRaw.mockReturnValue(new Promise(() => {}));
    const pending = GET();
    await vi.advanceTimersByTimeAsync(2_000);
    const res = await pending;
    vi.useRealTimers();
    expect(res.status).toBe(503);
  });
});
