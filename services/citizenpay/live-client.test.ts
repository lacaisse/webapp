// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The burn-claim wire: what api.ts sends and how live-client.ts reads it.
// Only `fetch` is faked; the live client's Prisma import is stubbed out.
vi.mock("server-only", () => ({}));
vi.mock("@/services/db/prisma", () => ({ prisma: {} }));

import { payouts } from "./api";
import { burnClaimFromWire, LiveCitizenPayClient } from "./live-client";

const creds = { baseUrl: "https://cp.test", apiKeyId: "0xkey", apiKey: "secret" };
type Call = { url: URL; method: string; body: unknown };
let calls: Call[];
let reply: { status: number; body?: unknown };

beforeEach(() => {
  calls = [];
  reply = { status: 204 };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      calls.push({
        url: new URL(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
        status: reply.status,
      });
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

describe("payouts.releaseBurnClaim (DELETE …/burn-claim)", () => {
  it.each([
    [{ claimId: "c-1" }, { claimId: "c-1" }],
    [{ force: true }, { force: "true" }],
    [{ claimId: "c-1", force: true }, { claimId: "c-1", force: "true" }],
    [{}, {}],
  ])("builds the query for %j", async (args, query) => {
    await payouts.releaseBurnClaim(creds, "p/1", args);
    const { url, method } = calls[0];
    expect(method).toBe("DELETE");
    expect(url.pathname).toBe("/v2/treasury/payouts/p%2F1/burn-claim");
    expect(Object.fromEntries(url.searchParams)).toEqual(query);
  });

  it("does not send force=false", async () => {
    await payouts.releaseBurnClaim(creds, "p1", { claimId: "c-1", force: false });
    expect(calls[0].url.searchParams.has("force")).toBe(false);
  });
});

describe("payouts.burn", () => {
  it("sends claimId and destination only when given", async () => {
    reply = { status: 200, body: { success: true } };
    await payouts.burn(creds, "p1", "0xtx");
    await payouts.burn(creds, "p1", "0xtx", "0xdest", "c-1");
    expect(calls[0].body).toEqual({ txHash: "0xtx" });
    expect(calls[1].body).toEqual({ txHash: "0xtx", destination: "0xdest", claimId: "c-1" });
  });
});

describe("LiveCitizenPayClient burn claim", () => {
  const client = new LiveCitizenPayClient(creds);

  it("returns the claim", async () => {
    reply = { status: 200, body: { claimId: "c-1", claimedAt: "2026-10-05T09:30:00Z" } };
    await expect(client.claimPayoutBurn("p1")).resolves.toEqual({
      claimId: "c-1",
      claimedAt: "2026-10-05T09:30:00Z",
    });
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url.pathname).toBe("/v2/treasury/payouts/p1/burn-claim");
  });

  // A 2xx without an id would let the burn run unguarded.
  it.each([{}, { claimId: "" }, null])("throws on a 2xx without a claimId (%j)", async (body) => {
    reply = { status: 200, body };
    await expect(client.claimPayoutBurn("p1")).rejects.toThrow(/claimId/);
  });

  it("maps burnClaim on /status, and its absence to null", async () => {
    reply = {
      status: 200,
      body: {
        status: "pending",
        burnClaim: { claimId: "c-1", claimedAt: "2026-10-05T09:30:00Z", source: "external" },
      },
    };
    expect((await client.getPayoutStatus("p1")).burnClaim).toEqual({
      claimId: "c-1",
      claimedAt: "2026-10-05T09:30:00Z",
      source: "external",
    });
    reply = { status: 200, body: { status: "pending" } };
    expect((await client.getPayoutStatus("p1")).burnClaim).toBeNull();
  });

  it("reports duplicateBurn", async () => {
    reply = { status: 200, body: { success: true, duplicateBurn: true } };
    expect((await client.burnPayout("p1", "0xtx", undefined, "c-1")).duplicateBurn).toBe(true);
  });
});

describe("burnClaimFromWire", () => {
  it("keeps a claim without an id (id null) and drops nothing else", () => {
    expect(
      burnClaimFromWire({ claimedAt: "2026-10-05T09:30:00Z", source: "external" }),
    ).toEqual({ claimId: null, claimedAt: "2026-10-05T09:30:00Z", source: "external" });
    expect(burnClaimFromWire(null)).toBeNull();
    expect(burnClaimFromWire(undefined)).toBeNull();
  });
});
