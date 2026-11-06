// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock mode (CITIZENPAY_API_BASE_URL unset) records the pushed kind per fund;
// the live cases run the live client against a faked fetch.
vi.mock("server-only", () => ({}));
vi.mock("@/services/db/prisma", () => ({ prisma: {} }));
const afterCallbacks = vi.hoisted(() => [] as Array<() => Promise<void>>);
vi.mock("next/server", () => ({
  after: (cb: () => Promise<void>) => afterCallbacks.push(cb),
}));

import { encryptSecret } from "@/services/crypto/secret";

import { getMockTreasuryKind } from "./client";
import { scheduleTreasuryKindSync, syncTreasuryKind } from "./sync-fund-kind";

const KEY = "11".repeat(32);
type FetchCall = [string, RequestInit];
let n = 0;
const connected = () => ({
  id: `fund-${++n}`,
  citizenPayApiKeyId: "0xkey",
  citizenPayApiKeyEnc: encryptSecret("secret"),
});

beforeEach(() => {
  vi.stubEnv("APP_CRED_KEY", KEY);
  vi.stubEnv("CITIZENPAY_API_BASE_URL", "");
  vi.spyOn(console, "log").mockImplementation(() => {});
  afterCallbacks.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("syncTreasuryKind", () => {
  it("marks a connected fund's treasury a fund", async () => {
    const fund = connected();
    await expect(syncTreasuryKind(fund)).resolves.toEqual({
      status: "synced",
      kind: "fund",
    });
    expect(getMockTreasuryKind(fund.id)).toBe("fund");
  });

  it("skips a fund that isn't connected to CitizenPay", async () => {
    const fund = { ...connected(), citizenPayApiKeyEnc: null };
    await expect(syncTreasuryKind(fund)).resolves.toEqual({
      status: "skipped",
      reason: "not_connected",
    });
    expect(getMockTreasuryKind(fund.id)).toBeUndefined();
  });

  it("sends one PATCH /v2/treasury { kind: \"fund\" } on the live client, no read first", async () => {
    vi.stubEnv("CITIZENPAY_API_BASE_URL", "https://cp.test");
    const fetchMock = vi.fn(async () =>
      Response.json({ success: true, kind: "fund" }, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(syncTreasuryKind(connected())).resolves.toEqual({
      status: "synced",
      kind: "fund",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [input, init] = fetchMock.mock.calls[0] as unknown as FetchCall;
    expect(new URL(input).pathname).toBe("/v2/treasury");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ kind: "fund" });
    const headers = new Headers(init.headers);
    expect(headers.get("x-api-key-id")).toBe("0xkey");
    expect(headers.get("x-api-key")).toBe("secret");
  });

  it("swallows a client error and reports it", async () => {
    vi.stubEnv("CITIZENPAY_API_BASE_URL", "https://cp.test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"error":"boom"}', { status: 500 })),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await syncTreasuryKind(connected());
    expect(result.status).toBe("failed");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("reports an api that predates the field (400) as failed, never throws", async () => {
    vi.stubEnv("CITIZENPAY_API_BASE_URL", "https://cp.test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"error":"feePercentageBps required"}', { status: 400 })),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(syncTreasuryKind(connected())).resolves.toMatchObject({ status: "failed" });
  });

  it("gives the CP call a 3 s budget", async () => {
    vi.stubEnv("CITIZENPAY_API_BASE_URL", "https://cp.test");
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_: string, init: RequestInit) =>
          new Promise((_resolve, reject) =>
            init.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
          ),
      ),
    );
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const pending = syncTreasuryKind(connected());
    await vi.advanceTimersByTimeAsync(2_999);
    let settled = false;
    void pending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toMatchObject({ status: "failed" });
    vi.useRealTimers();
  });
});

describe("scheduleTreasuryKindSync", () => {
  it("defers the push to after() instead of running it in the request", async () => {
    const fund = connected();
    scheduleTreasuryKindSync(fund);
    expect(getMockTreasuryKind(fund.id)).toBeUndefined();
    expect(afterCallbacks).toHaveLength(1);
    await afterCallbacks[0]();
    expect(getMockTreasuryKind(fund.id)).toBe("fund");
  });
});
