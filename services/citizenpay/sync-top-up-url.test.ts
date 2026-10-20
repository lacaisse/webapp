// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock mode (CITIZENPAY_API_BASE_URL unset) records the pushed URL per fund;
// the failure case runs the live client against a faked fetch.
vi.mock("server-only", () => ({}));
vi.mock("@/services/db/prisma", () => ({ prisma: {} }));

import { encryptSecret } from "@/services/crypto/secret";

import { getMockTreasuryTopUpUrl } from "./client";
import { syncTreasuryTopUpUrl } from "./sync-top-up-url";

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

  it.each(["FIXED_PERIOD", "DISABLED"] as const)("clears it for %s", async (mode) => {
    const fund = connected(mode);
    await expect(syncTreasuryTopUpUrl(fund)).resolves.toEqual({
      status: "synced",
      url: null,
    });
    expect(getMockTreasuryTopUpUrl(fund.id)).toBeNull();
  });

  it("skips a fund that isn't connected to CitizenPay", async () => {
    const fund = { ...connected("PAY_AND_GO"), citizenPayApiKeyEnc: null };
    await expect(syncTreasuryTopUpUrl(fund)).resolves.toEqual({ status: "skipped" });
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
});
