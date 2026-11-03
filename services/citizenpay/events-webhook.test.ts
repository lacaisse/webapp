// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Registering the events webhook with the api: the secret is minted once,
// stored before it is sent and kept across re-registrations, the outcome
// lands on the fund row, a non-https url never reaches the live api.
vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: (fn: () => Promise<void>) => void fn() }));
vi.mock("@/services/crypto/secret", () => ({
  encryptSecret: (s: string) => `enc:${s}`,
  decryptSecret: (s: string) => s.replace(/^enc:/, ""),
}));

const prisma = vi.hoisted(() => ({ fund: { update: vi.fn() } }));
vi.mock("@/services/db/prisma", () => ({ prisma }));

const cp = vi.hoisted(() => ({ setTreasuryEventsWebhook: vi.fn() }));
vi.mock("./client", () => ({ getCitizenPayClient: () => cp }));

import { registerTreasuryEventsWebhook } from "./events-webhook";

const fund = {
  id: "fund-1",
  domain: "acme.lacaisse.eu",
  citizenPayApiKeyId: "0xkey",
  citizenPayApiKeyEnc: "v1:enc",
  citizenPayEventsSecretEnc: null as string | null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("NODE_ENV", "production");
  process.env.APP_DOMAIN = "lacaisse.eu";
  delete process.env.CITIZENPAY_API_BASE_URL;
  prisma.fund.update.mockResolvedValue({});
  cp.setTreasuryEventsWebhook.mockResolvedValue(undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("registerTreasuryEventsWebhook", () => {
  it("skips a fund without credentials", async () => {
    const res = await registerTreasuryEventsWebhook({ ...fund, citizenPayApiKeyEnc: null });
    expect(res).toEqual({ status: "skipped", reason: "not_connected" });
    expect(cp.setTreasuryEventsWebhook).not.toHaveBeenCalled();
  });

  it("mints a 32-byte secret, stores it encrypted BEFORE sending it, then marks the registration", async () => {
    const res = await registerTreasuryEventsWebhook(fund);
    expect(res).toEqual({
      status: "registered",
      url: "https://acme.lacaisse.eu/api/citizenpay/events",
    });
    const [{ url, secret }] = cp.setTreasuryEventsWebhook.mock.calls[0];
    expect(url).toBe("https://acme.lacaisse.eu/api/citizenpay/events");
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(prisma.fund.update).toHaveBeenNthCalledWith(1, {
      where: { id: "fund-1" },
      data: { citizenPayEventsSecretEnc: `enc:${secret}` },
    });
    expect(prisma.fund.update.mock.invocationCallOrder[0]).toBeLessThan(
      cp.setTreasuryEventsWebhook.mock.invocationCallOrder[0],
    );
    expect(prisma.fund.update).toHaveBeenNthCalledWith(2, {
      where: { id: "fund-1" },
      data: {
        citizenPayEventsWebhookRegisteredAt: expect.any(Date),
        citizenPayEventsWebhookError: null,
      },
    });
  });

  it("re-sends the stored secret on a re-registration", async () => {
    await registerTreasuryEventsWebhook({ ...fund, citizenPayEventsSecretEnc: "enc:oldsecret" });
    expect(cp.setTreasuryEventsWebhook).toHaveBeenCalledExactlyOnceWith({
      url: "https://acme.lacaisse.eu/api/citizenpay/events",
      secret: "oldsecret",
    });
    expect(prisma.fund.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: "fund-1" },
      data: {
        citizenPayEventsWebhookRegisteredAt: expect.any(Date),
        citizenPayEventsWebhookError: null,
      },
    });
  });

  it("records a refusal on the fund and keeps the stored secret", async () => {
    cp.setTreasuryEventsWebhook.mockRejectedValue(new Error("feePercentageBps is required"));
    const res = await registerTreasuryEventsWebhook({ ...fund, citizenPayEventsSecretEnc: "enc:oldsecret" });
    expect(res).toEqual({
      status: "failed",
      url: "https://acme.lacaisse.eu/api/citizenpay/events",
      error: "feePercentageBps is required",
    });
    expect(prisma.fund.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: "fund-1" },
      data: { citizenPayEventsWebhookError: "feePercentageBps is required" },
    });
  });

  it("holds a minted secret the api refused, so the retry sends the same one", async () => {
    cp.setTreasuryEventsWebhook.mockRejectedValue(new Error("down"));
    await registerTreasuryEventsWebhook(fund);
    const [{ secret }] = cp.setTreasuryEventsWebhook.mock.calls[0];
    expect(prisma.fund.update).toHaveBeenNthCalledWith(1, {
      where: { id: "fund-1" },
      data: { citizenPayEventsSecretEnc: `enc:${secret}` },
    });
    expect(prisma.fund.update).toHaveBeenNthCalledWith(2, {
      where: { id: "fund-1" },
      data: { citizenPayEventsWebhookError: "down" },
    });
  });

  it("never sends a non-https url to the live api", async () => {
    vi.stubEnv("NODE_ENV", "development");
    process.env.APP_DOMAIN = "localhost";
    process.env.CITIZENPAY_API_BASE_URL = "https://cp.test";
    const res = await registerTreasuryEventsWebhook(fund);
    expect(res).toEqual({ status: "skipped", reason: "insecure_url" });
    expect(cp.setTreasuryEventsWebhook).not.toHaveBeenCalled();
  });

  it("registers a dev url with the in-process mock", async () => {
    vi.stubEnv("NODE_ENV", "development");
    process.env.APP_DOMAIN = "localhost";
    process.env.PORT = "3033";
    const res = await registerTreasuryEventsWebhook(fund);
    expect(res).toMatchObject({
      status: "registered",
      url: "http://acme.localhost:3033/api/citizenpay/events",
    });
  });
});
