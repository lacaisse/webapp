// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Pins the top-up URL wiring on the general settings save: the save commits
// and returns ok, and the CitizenPay push is deferred to after() — so a
// failing (or hung) CP can't fail or stall it.
vi.mock("server-only", () => ({}));
const { afterCallbacks, fundUpdate } = vi.hoisted(() => ({
  afterCallbacks: [] as Array<() => Promise<void>>,
  fundUpdate: vi.fn(),
}));
vi.mock("next/server", () => ({
  after: (cb: () => Promise<void>) => afterCallbacks.push(cb),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
}));
vi.mock("@/services/auth/dal", () => ({
  requireFundRole: async () => ({ fund: { id: "fund-1" } }),
}));
vi.mock("@/services/db/prisma", () => ({ prisma: { fund: { update: fundUpdate } } }));

import { encryptSecret } from "@/services/crypto/secret";

import { updateGeneralSettingsAction } from "./settings-actions";

const input = {
  name: "La Class",
  fullName: null,
  defaultLocale: "fr" as const,
  timezone: "Europe/Brussels",
  allocationMode: "PAY_AND_GO" as const,
  allocationCutoffDay: 31,
};

beforeEach(() => {
  afterCallbacks.length = 0;
  vi.stubEnv("APP_CRED_KEY", "22".repeat(32));
  vi.stubEnv("CITIZENPAY_API_BASE_URL", "https://cp.test");
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("APP_DOMAIN", "lacaisse.eu");
  fundUpdate.mockImplementation(async ({ data }) => ({
    id: "fund-1",
    domain: "laclass.lacaisse.eu",
    citizenPayApiKeyId: "0xkey",
    citizenPayApiKeyEnc: encryptSecret("secret"),
    ...data,
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("updateGeneralSettingsAction → top-up URL", () => {
  it("saves, returns ok, and schedules the sync for after the response", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    // FIXED_PERIOD publishes its cotisation page; PAY_AND_GO publishes nothing
    // (CP serves its checkout link) — see services/citizenpay/top-up-url.ts.
    await expect(
      updateGeneralSettingsAction({ ...input, allocationMode: "FIXED_PERIOD" }),
    ).resolves.toEqual({ ok: true });
    expect(fundUpdate).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(afterCallbacks).toHaveLength(1);

    await afterCallbacks[0]();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(url).pathname).toBe("/v2/treasury");
    expect(JSON.parse(String(init.body))).toEqual({
      topUpUrl: "https://laclass.lacaisse.eu/pay/{serial}",
    });
  });

  it("still returns ok when CitizenPay fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"error":"down"}', { status: 503 })),
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      updateGeneralSettingsAction({ ...input, allocationMode: "FIXED_PERIOD" }),
    ).resolves.toEqual({ ok: true });
    await expect(afterCallbacks[0]()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });
});
