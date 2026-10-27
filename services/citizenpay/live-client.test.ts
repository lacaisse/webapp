// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The burn-claim wire: what api.ts sends and how live-client.ts reads it.
// Only `fetch` is faked; the live client's Prisma import is stubbed out.
vi.mock("server-only", () => ({}));
vi.mock("@/services/db/prisma", () => ({ prisma: {} }));

import { cards, payouts } from "./api";
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

describe("cards.setHolderName (PUT …/profile)", () => {
  it.each([["Jane Doe"], [null]])("sends { name: %j }", async (name) => {
    reply = { status: 200, body: { account: "0xabc", name: name ?? "Card S/1" } };
    const res = await cards.setHolderName(creds, "S/1", name);
    const { url, method, body } = calls[0];
    expect(method).toBe("PUT");
    expect(url.pathname).toBe("/v2/treasury/cards/S%2F1/profile");
    expect(body).toEqual({ name });
    expect(res.account).toBe("0xabc");
  });

  it("surfaces a 404 as CitizenPayApiError", async () => {
    reply = { status: 404, body: { error: "card not found" } };
    await expect(
      new LiveCitizenPayClient(creds).setCardHolderName("S1", "Jane"),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe("getStats (GET /v2/treasury/stats)", () => {
  const bucket = { count: 3, refundCount: 1, total: 12345, fees: 100, payoutFees: 45, net: 12200 };

  it("passes the window and maps cents to decimals", async () => {
    reply = {
      status: 200,
      body: {
        from: "2026-01-01T00:00:00Z",
        to: null,
        orders: bucket,
        months: [{ ...bucket, month: "2026-09" }],
        places: [{ ...bucket, placeId: "p1", placeName: "Bakery", placeImage: "", businessId: "b1" }],
      },
    };
    const s = await new LiveCitizenPayClient(creds).getStats({ from: "2026-01-01T00:00:00Z" });
    expect(calls[0].url.pathname).toBe("/v2/treasury/stats");
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({ from: "2026-01-01T00:00:00Z" });
    const money = { count: 3, refundCount: 1, total: "123.45", fees: "1.00", payoutFees: "0.45", net: "122.00" };
    expect(s).toEqual({
      from: "2026-01-01T00:00:00Z",
      to: null,
      orders: money,
      months: [{ ...money, month: "2026-09" }],
      places: [{ ...money, placeId: "p1", placeName: "Bakery", placeImage: null, businessId: "b1" }],
    });
  });

  it("reads null arrays and a missing businessId as empty", async () => {
    reply = {
      status: 200,
      body: { from: null, to: null, orders: { ...bucket, total: -500, net: -645 }, months: null, places: null },
    };
    const s = await new LiveCitizenPayClient(creds).getStats();
    expect(s.months).toEqual([]);
    expect(s.places).toEqual([]);
    expect(s.orders.total).toBe("-5.00");

    reply = {
      status: 200,
      body: { from: null, to: null, orders: bucket, months: [], places: [{ ...bucket, placeId: "p1", placeName: "X" }] },
    };
    const t = await new LiveCitizenPayClient(creds).getStats();
    expect(t.places[0]).toMatchObject({ placeImage: null, businessId: null });
  });
});

describe("LiveCitizenPayClient card source info / weekly limit", () => {
  const client = new LiveCitizenPayClient(creds);
  const card = { serial: "S1", status: "active", created_at: "", updated_at: "" };

  it("reads source, cap and allowance", async () => {
    reply = {
      status: 200,
      body: {
        card: { ...card, source_serial: "SRC", source_weekly_limit: 1000 },
        allowance: { limit: 1000, spent: 700, remaining: 300, resets_at: "2026-11-02T23:00:00Z" },
      },
    };
    expect(await client.getCardSourceInfo("S/1")).toEqual({
      sourceSerial: "SRC",
      weeklyLimit: 1000,
      allowance: {
        limit: 1000,
        spent: 700,
        remaining: 300,
        resetsAt: new Date("2026-11-02T23:00:00Z"),
      },
    });
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url.pathname).toBe("/v2/treasury/cards/S%2F1");
  });

  it("reads a missing allowance (older CP deploy) and missing fields as null", async () => {
    reply = { status: 200, body: { card: { ...card, source_serial: "SRC", source_weekly_limit: 1000 } } };
    expect(await client.getCardSourceInfo("S1")).toEqual({
      sourceSerial: "SRC",
      weeklyLimit: 1000,
      allowance: null,
    });
    reply = { status: 200, body: { card: { ...card, source_serial: "", source_weekly_limit: 0 }, allowance: null } };
    expect(await client.getCardSourceInfo("S1")).toEqual({
      sourceSerial: null,
      weeklyLimit: null,
      allowance: null,
    });
  });

  it("reads a malformed allowance as null", async () => {
    reply = {
      status: 200,
      body: { card, allowance: { limit: 1000, spent: 0, remaining: 1000, resets_at: "soon" } },
    };
    expect((await client.getCardSourceInfo("S1")).allowance).toBeNull();
  });

  it("maps a 404 to all nulls", async () => {
    reply = { status: 404, body: { error: "card not found" } };
    expect(await client.getCardSourceInfo("S1")).toEqual({
      sourceSerial: null,
      weeklyLimit: null,
      allowance: null,
    });
  });

  it("rethrows other errors", async () => {
    reply = { status: 500, body: { error: "boom" } };
    await expect(client.getCardSourceInfo("S1")).rejects.toMatchObject({ status: 500 });
  });

  it.each([
    [1000, 1000],
    [null, 0],
  ])("setCardSourceLimit(%j) PATCHes source_weekly_limit=%d only", async (limit, wire) => {
    reply = { status: 200, body: { source_weekly_limit: wire } };
    await client.setCardSourceLimit("S1", limit);
    expect(calls[0].method).toBe("PATCH");
    expect(calls[0].url.pathname).toBe("/v2/treasury/cards/S1");
    expect(calls[0].body).toEqual({ source_weekly_limit: wire });
  });
});
