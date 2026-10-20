// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock mode (CITIZENPAY_API_BASE_URL unset) records the pushed URL per fund;
// the failure case runs the live client against a faked fetch.
vi.mock("server-only", () => ({}));
vi.mock("@/services/db/prisma", () => ({ prisma: {} }));
const afterCallbacks = vi.hoisted(() => [] as Array<() => Promise<void>>);
vi.mock("next/server", () => ({
  after: (cb: () => Promise<void>) => afterCallbacks.push(cb),
}));

import { encryptSecret } from "@/services/crypto/secret";

import { getMockTreasuryTopUpUrl } from "./client";
import {
  scheduleTreasuryTopUpUrlSync,
  syncTreasuryTopUpUrl,
} from "./sync-top-up-url";

const KEY = "11".repeat(32);
let n = 0;
const connected = (allocationMode: "PAY_AND_GO" | "FIXED_PERIOD" | "DISABLED") => ({
  id: `fund-${++n}`,
  domain: "laclass.lacaisse.eu",
  allocationMode,
  citizenPayApiKeyId: "0xkey",
  citizenPayApiKeyEnc: encryptSecret("secret"),
});

beforeEach(() => {
  vi.stubEnv("APP_CRED_KEY", KEY);
  vi.stubEnv("CITIZENPAY_API_BASE_URL", "");
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("APP_DOMAIN", "lacaisse.eu");
  vi.spyOn(console, "log").mockImplementation(() => {});
  afterCallbacks.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("syncTreasuryTopUpUrl", () => {
  it("sets the contribution link for a PAY_AND_GO fund", async () => {
    const fund = connected("PAY_AND_GO");
    const url = "https://laclass.lacaisse.eu/pay/{serial}";
    await expect(syncTreasuryTopUpUrl(fund)).resolves.toEqual({ status: "synced", url });
    expect(getMockTreasuryTopUpUrl(fund.id)).toBe(url);
  });

  it.each(["DISABLED"] as const)("clears it for %s", async (mode) => {
    const fund = connected(mode);
    await expect(syncTreasuryTopUpUrl(fund)).resolves.toEqual({
      status: "synced",
      url: null,
    });
    expect(getMockTreasuryTopUpUrl(fund.id)).toBeNull();
  });

  it("skips a fund that isn't connected to CitizenPay", async () => {
    const fund = { ...connected("PAY_AND_GO"), citizenPayApiKeyEnc: null };
    await expect(syncTreasuryTopUpUrl(fund)).resolves.toEqual({
      status: "skipped",
      reason: "not_connected",
    });
    expect(getMockTreasuryTopUpUrl(fund.id)).toBeUndefined();
  });

  it("sends PATCH /v2/treasury { topUpUrl } on the live client", async () => {
    vi.stubEnv("CITIZENPAY_API_BASE_URL", "https://cp.test");
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await syncTreasuryTopUpUrl(connected("PAY_AND_GO"));
    const [input, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(input).pathname).toBe("/v2/treasury");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({
      topUpUrl: "https://laclass.lacaisse.eu/pay/{serial}",
    });
  });

  it("swallows a client error and reports it", async () => {
    vi.stubEnv("CITIZENPAY_API_BASE_URL", "https://cp.test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"error":"boom"}', { status: 500 })),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await syncTreasuryTopUpUrl(connected("FIXED_PERIOD"));
    expect(result.status).toBe("failed");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("never pushes a non-https URL to the live API (dev pointed at real CP)", async () => {
    vi.stubEnv("CITIZENPAY_API_BASE_URL", "https://cp.test");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("APP_DOMAIN", "localhost");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(syncTreasuryTopUpUrl(connected("PAY_AND_GO"))).resolves.toEqual({
      status: "skipped",
      reason: "insecure_url",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("still clears (null) on the live API whatever the environment", async () => {
    vi.stubEnv("CITIZENPAY_API_BASE_URL", "https://cp.test");
    vi.stubEnv("NODE_ENV", "development");
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(syncTreasuryTopUpUrl(connected("DISABLED"))).resolves.toEqual({
      status: "synced",
      url: null,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
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
    const pending = syncTreasuryTopUpUrl(connected("PAY_AND_GO"));
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

describe("scheduleTreasuryTopUpUrlSync", () => {
  it("defers the push to after() instead of running it in the request", async () => {
    const fund = connected("PAY_AND_GO");
    scheduleTreasuryTopUpUrlSync(fund);
    expect(getMockTreasuryTopUpUrl(fund.id)).toBeUndefined();
    expect(afterCallbacks).toHaveLength(1);
    await afterCallbacks[0]();
    expect(getMockTreasuryTopUpUrl(fund.id)).toBe(
      "https://laclass.lacaisse.eu/pay/{serial}",
    );
  });
});
