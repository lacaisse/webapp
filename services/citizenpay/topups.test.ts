// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The terminal top-up wire (GET /v2/treasury/topups, claim / credit / reverse):
// what api.ts sends, how live-client.ts reads it, and the mock client's
// claim rules. Only `fetch` is faked; the Prisma import is stubbed out.
vi.mock("server-only", () => ({}));
vi.mock("@/services/db/prisma", () => ({ prisma: {} }));

import { CitizenPayApiError, topups } from "./api";
import {
  getCitizenPayClient,
  getMockTopUpOrder,
  seedMockTopUpOrder,
} from "./client";
import { LiveCitizenPayClient, topUpOrderFromWire } from "./live-client";

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
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("topups request shapes", () => {
  it("lists by state", async () => {
    reply = { status: 200, body: { topups: [] } };
    await topups.list(creds, "reversal_pending");
    expect(calls[0].method).toBe("GET");
    expect(calls[0].url.pathname).toBe("/v2/treasury/topups");
    expect(Object.fromEntries(calls[0].url.searchParams)).toEqual({ state: "reversal_pending" });
  });

  it("claims with an empty POST", async () => {
    reply = { status: 200, body: { claimId: "c-1", expiresAt: "2026-10-21T10:10:00Z" } };
    await topups.claim(creds, 42);
    expect(calls[0].method).toBe("POST");
    expect(calls[0].url.pathname).toBe("/v2/treasury/topups/42/claim");
    expect(calls[0].body).toBeUndefined();
  });

  it("credits and reverses with {claimId, txHash}", async () => {
    await topups.credit(creds, 42, { claimId: "c-1", txHash: "0xtx" });
    await topups.reverse(creds, 43, { claimId: "c-2", txHash: "0xty" });
    expect(calls[0].url.pathname).toBe("/v2/treasury/topups/42/credit");
    expect(calls[0].body).toEqual({ claimId: "c-1", txHash: "0xtx" });
    expect(calls[1].url.pathname).toBe("/v2/treasury/topups/43/reverse");
    expect(calls[1].body).toEqual({ claimId: "c-2", txHash: "0xty" });
  });

  it("surfaces CP's 409 text", async () => {
    reply = { status: 409, body: { error: "claim does not match" } };
    const e = await topups
      .credit(creds, 42, { claimId: "c-1", txHash: "0xtx" })
      .then(() => null, (err: unknown) => err);
    expect(e).toBeInstanceOf(CitizenPayApiError);
    expect((e as CitizenPayApiError).status).toBe(409);
    expect((e as CitizenPayApiError).message).toBe("claim does not match");
  });
});

describe("LiveCitizenPayClient top-ups", () => {
  const client = new LiveCitizenPayClient(creds);

  it("normalises a listed order (cents, dates, coerced ids)", () => {
    expect(
      topUpOrderFromWire({
        orderId: "42" as unknown as number,
        serial: "04A2",
        cardAddress: "0xcard",
        amount: 1250,
        token: "0xtoken",
        placeId: 7,
        placeName: "Bar du Coin",
        paidAt: "2026-10-21T09:58:00Z",
        state: "pending",
        claimedAt: null,
      }),
    ).toEqual({
      orderId: 42,
      serial: "04A2",
      cardAddress: "0xcard",
      amountCents: 1250,
      token: "0xtoken",
      placeId: "7",
      placeName: "Bar du Coin",
      paidAt: new Date("2026-10-21T09:58:00Z"),
      state: "pending",
      claimedAt: null,
    });
  });

  it("tolerates a null list and missing optionals", async () => {
    reply = { status: 200, body: { topups: null } };
    await expect(client.listTopUpOrders("pending")).resolves.toEqual([]);
    expect(
      topUpOrderFromWire({
        orderId: 1,
        serial: "s",
        cardAddress: "0x",
        amount: 100,
        token: "0xt",
        state: "pending",
      }),
    ).toMatchObject({ placeId: null, placeName: null, paidAt: null, claimedAt: null });
  });

  it("returns the claim and fails closed without a claimId", async () => {
    reply = { status: 200, body: { claimId: "c-1", expiresAt: "2026-10-21T10:10:00Z" } };
    await expect(client.claimTopUpOrder(42)).resolves.toEqual({
      claimId: "c-1",
      expiresAt: new Date("2026-10-21T10:10:00Z"),
    });
    reply = { status: 200, body: {} };
    await expect(client.claimTopUpOrder(42)).rejects.toThrow(/no claimId/);
  });
});

describe("mock client top-ups", () => {
  const fund = { id: "f1", citizenPayApiKeyId: null, citizenPayApiKeyEnc: null };
  let n = 900_000;
  const fresh = () => ++n;

  beforeEach(() => {
    vi.stubEnv("CITIZENPAY_API_BASE_URL", "");
  });
  afterEach(() => vi.unstubAllEnvs());

  async function refusal(p: Promise<unknown>): Promise<string> {
    const e = await p.then(() => null, (err: unknown) => err);
    expect(e).toBeInstanceOf(CitizenPayApiError);
    expect((e as CitizenPayApiError).status).toBe(409);
    return (e as CitizenPayApiError).message;
  }

  it("lists, claims once, credits with the claim, then lists nothing", async () => {
    const cp = getCitizenPayClient(fund);
    const id = fresh();
    seedMockTopUpOrder({ orderId: id, serial: "s", cardAddress: "0xcard", amountCents: 500 });
    const listed = await cp.listTopUpOrders("pending");
    expect(listed.find((o) => o.orderId === id)).toMatchObject({
      amountCents: 500,
      state: "pending",
      claimedAt: null,
    });

    const { claimId } = await cp.claimTopUpOrder(id);
    expect(await refusal(cp.claimTopUpOrder(id))).toBe("claim in progress");
    expect(
      await refusal(cp.creditTopUpOrder(id, { claimId: "other", txHash: "0x1" })),
    ).toBe("claim does not match");

    await cp.creditTopUpOrder(id, { claimId, txHash: "0x1" });
    expect(getMockTopUpOrder(id)).toEqual({ state: "credited", claimed: false, txHash: "0x1" });
    expect((await cp.listTopUpOrders("pending")).some((o) => o.orderId === id)).toBe(false);
    expect(await refusal(cp.claimTopUpOrder(id))).toBe("already credited");
    expect(
      await refusal(cp.creditTopUpOrder(id, { claimId, txHash: "0x1" })),
    ).toBe("already credited");
  });

  it("reverses a reversal_pending order and refuses a credit on it", async () => {
    const cp = getCitizenPayClient(fund);
    const id = fresh();
    seedMockTopUpOrder({
      orderId: id,
      serial: "s",
      cardAddress: "0xcard",
      amountCents: 500,
      state: "reversal_pending",
    });
    expect((await cp.listTopUpOrders("reversal_pending")).some((o) => o.orderId === id)).toBe(true);
    const { claimId } = await cp.claimTopUpOrder(id);
    expect(await refusal(cp.creditTopUpOrder(id, { claimId, txHash: "0x2" }))).toBe("not pending");
    await cp.reverseTopUpOrder(id, { claimId, txHash: "0x2" });
    expect(getMockTopUpOrder(id)).toMatchObject({ state: "reversed", txHash: "0x2" });
  });
});
