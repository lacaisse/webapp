// SPDX-License-Identifier: AGPL-3.0-or-later
import { getAddress } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { COW_CONTRACTS_BY_CHAIN } from "./assets";
import {
  cowApiBaseUrl,
  getOrder,
  getTrades,
  postPreSignOrder,
  preparedOrderRequest,
  preparedQuoteRequest,
  requestQuote,
  retryAfterMs,
} from "./cow-api";
import { APP_DATA_DOC, APP_DATA_HASH, orderUid, type CowOrder } from "./cow-order";

// The orderbook client against a stubbed fetch: request shapes, the answers
// it accepts, and the ones it refuses (services/safe/tx-service.test.ts
// pattern).

const SAFE = getAddress("0x5afe00000000000000000000000000000000cafe");
const EURE = getAddress("0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430");
const WXDAI = getAddress("0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d");
const ORDER: CowOrder = {
  sellToken: EURE,
  buyToken: WXDAI,
  receiver: SAFE,
  sellAmount: BigInt("500000000000000000"),
  buyAmount: BigInt("557364217142754180"),
  validTo: 1794295416,
  appData: APP_DATA_HASH,
  feeAmount: BigInt(0),
  kind: "sell",
  partiallyFillable: false,
  sellTokenBalance: "erc20",
  buyTokenBalance: "erc20",
};
const UID = orderUid(100, COW_CONTRACTS_BY_CHAIN[100].settlement, ORDER, SAFE);

type Call = { url: string; init?: RequestInit };
let calls: Call[];
function stubFetch(responder: (url: string, init?: RequestInit, n?: number) => Response | Promise<Response>) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return responder(url, init, calls.length);
    }),
  );
}
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
// The hosted orderbook's 429 for a quote from a shared cloud IP (seen from
// Vercel on 2026-11-04): the pitch for its paid quote service.
const THROTTLED = {
  error:
    "You can use x402.api.cow.fi for pay-as-you-go requests. Docs: https://x402.cow.fi/docs. If you route more than $1M in monthly trading volume, reach out to @MooKeeper on the CoW Protocol Discord server to discuss a partner integration.",
};
const bodyOf = (c: Call) => JSON.parse(String(c.init?.body)) as Record<string, unknown>;

beforeEach(() => {
  vi.stubEnv("COW_API_URL", "");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("base url", () => {
  it("hosted orderbook per chain, COW_API_URL overrides, unknown chain is null", () => {
    expect(cowApiBaseUrl(100)).toBe("https://api.cow.fi/xdai");
    expect(cowApiBaseUrl(1)).toBeNull();
    vi.stubEnv("COW_API_URL", "https://cow.test/");
    expect(cowApiBaseUrl(1)).toBe("https://cow.test");
  });
});

describe("requestQuote", () => {
  it("asks for a pre-sign sell quote from the owner and parses the amounts", async () => {
    stubFetch(() =>
      json(200, {
        quote: { sellAmount: "499700000000000000", feeAmount: "300000000000000", buyAmount: "560165000000000000", validTo: 1794295416 },
        expiration: "2026-11-03T08:00:00Z",
        id: 42,
      }),
    );
    const q = await requestQuote(100, {
      sellToken: EURE,
      buyToken: WXDAI,
      owner: SAFE,
      sellAmountBeforeFee: BigInt("500000000000000000"),
      appDataDoc: APP_DATA_DOC,
      appDataHash: APP_DATA_HASH,
      validFor: 600,
    });
    expect(q).toEqual({
      sellAmount: BigInt("499700000000000000"),
      feeAmount: BigInt("300000000000000"),
      buyAmount: BigInt("560165000000000000"),
      validTo: 1794295416,
      expiration: new Date("2026-11-03T08:00:00Z"),
      id: 42,
    });
    expect(calls[0].url).toBe("https://api.cow.fi/xdai/api/v1/quote");
    expect(bodyOf(calls[0])).toMatchObject({
      sellToken: EURE,
      buyToken: WXDAI,
      from: SAFE,
      receiver: SAFE,
      kind: "sell",
      sellAmountBeforeFee: "500000000000000000",
      signingScheme: "presign",
      appData: APP_DATA_DOC,
      appDataHash: APP_DATA_HASH,
    });
  });

  it("a 400 is a quote problem, a 500 an outage, junk a shape error", async () => {
    const req = {
      sellToken: EURE,
      buyToken: WXDAI,
      owner: SAFE,
      sellAmountBeforeFee: BigInt(1),
      appDataDoc: APP_DATA_DOC,
      appDataHash: APP_DATA_HASH,
      validFor: 600,
    };
    stubFetch(() => json(400, { errorType: "SellAmountDoesNotCoverFee" }));
    await expect(requestQuote(100, req)).rejects.toMatchObject({ code: "quote_failed" });
    stubFetch(() => json(503, {}));
    await expect(requestQuote(100, req)).rejects.toMatchObject({ code: "cow_api" });
    stubFetch(() => json(200, { quote: { sellAmount: "x" }, expiration: "2026-11-03T08:00:00Z" }));
    await expect(requestQuote(100, req)).rejects.toMatchObject({ code: "cow_api" });
    await expect(requestQuote(1, req)).rejects.toMatchObject({ code: "config" });
  });

  const req = {
    sellToken: EURE,
    buyToken: WXDAI,
    owner: SAFE,
    sellAmountBeforeFee: BigInt("500000000000000000"),
    appDataDoc: APP_DATA_DOC,
    appDataHash: APP_DATA_HASH,
    validFor: 600,
  };
  const QUOTE = {
    quote: { sellAmount: "499999994414625623", feeAmount: "5585374377", buyAmount: "560166047667388179", validTo: 1794295416 },
    expiration: "2026-11-03T08:00:00Z",
    id: 7,
  };

  it("a 429 is retried: 2 s, then 4 s, before the quota is reported as rate_limited", async () => {
    vi.useFakeTimers();
    try {
      stubFetch((_url, _init, n) => (n === 3 ? json(200, QUOTE) : json(429, THROTTLED)));
      const p = requestQuote(100, req);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(3_999);
      expect(calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toHaveLength(3);
      await expect(p).resolves.toMatchObject({ buyAmount: BigInt("560166047667388179"), id: 7 });

      stubFetch(() => json(429, THROTTLED));
      const q = requestQuote(100, req);
      const expectation = expect(q).rejects.toMatchObject({
        code: "rate_limited",
        message: expect.stringContaining("x402.api.cow.fi"),
      });
      await vi.advanceTimersByTimeAsync(6_000);
      await expectation;
      expect(calls).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("honours Retry-After when the orderbook sends one", async () => {
    vi.useFakeTimers();
    try {
      stubFetch((_url, _init, n) => (n === 1 ? json(429, THROTTLED, { "retry-after": "1" }) : json(200, QUOTE)));
      const p = requestQuote(100, req);
      await vi.advanceTimersByTimeAsync(999);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(calls).toHaveLength(2);
      await expect(p).resolves.toMatchObject({ id: 7 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up at once on a Retry-After longer than it would wait, instead of retrying early", async () => {
    vi.useFakeTimers();
    try {
      stubFetch(() => json(429, THROTTLED, { "retry-after": "30" }));
      const p = requestQuote(100, req);
      const expectation = expect(p).rejects.toMatchObject({ code: "rate_limited" });
      await vi.advanceTimersByTimeAsync(0);
      await expectation;
      expect(calls).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a quote the browser fetched (preparedQuoteRequest → requestQuote relayed)", () => {
  const NOW = new Date("2026-11-04T17:22:11Z");
  const req = {
    sellToken: EURE,
    buyToken: WXDAI,
    owner: SAFE,
    sellAmountBeforeFee: BigInt("10000000000000000000"),
    appDataDoc: APP_DATA_DOC,
    appDataHash: APP_DATA_HASH,
    validFor: 604_800,
  };
  // The orderbook's answer to exactly that request (Gnosis, 2026-11-04),
  // echo fields included.
  const ANSWER = {
    quote: {
      sellToken: EURE.toLowerCase(),
      buyToken: WXDAI.toLowerCase(),
      receiver: SAFE.toLowerCase(),
      sellAmount: "9999999955492985179",
      buyAmount: "11227511339554350270",
      validTo: 1794417731,
      appData: APP_DATA_DOC,
      appDataHash: APP_DATA_HASH,
      feeAmount: "44507014821",
      kind: "sell",
      partiallyFillable: false,
      sellTokenBalance: "erc20",
      buyTokenBalance: "erc20",
      signingScheme: "presign",
    },
    from: SAFE.toLowerCase(),
    expiration: "2026-11-04T17:24:11.948896861Z",
    id: 255834133,
    verified: false,
  };
  const relayed = (body: unknown, status = 200) => ({ status, text: JSON.stringify(body) });
  const noFetch = () => stubFetch(() => Promise.reject(new Error("the server must not call out")));

  it("the prepared request is the request the server would send, byte for byte", async () => {
    stubFetch(() => json(200, ANSWER));
    await requestQuote(100, req);
    const prepared = preparedQuoteRequest(100, req);
    expect(prepared).toEqual({
      method: "POST",
      url: "https://api.cow.fi/xdai/api/v1/quote",
      headers: { "content-type": "application/json" },
      body: String(calls[0].init?.body),
    });
    expect(() => preparedQuoteRequest(1, req)).toThrow(expect.objectContaining({ code: "config" }));
  });

  it("the relayed answer is parsed without a call, once checked against the request", async () => {
    noFetch();
    const q = await requestQuote(100, req, { relayed: relayed(ANSWER), now: NOW });
    expect(q).toEqual({
      sellAmount: BigInt("9999999955492985179"),
      feeAmount: BigInt("44507014821"),
      buyAmount: BigInt("11227511339554350270"),
      validTo: 1794417731,
      expiration: new Date("2026-11-04T17:24:11.948Z"),
      id: 255834133,
    });
    expect(calls).toHaveLength(0);
  });

  it("an answer to another request is relay_mismatch; a stale one is quote_moved (quote again)", async () => {
    noFetch();
    const refused = async (patch: Record<string, unknown>, topLevel = false) => {
      const body = topLevel ? { ...ANSWER, ...patch } : { ...ANSWER, quote: { ...ANSWER.quote, ...patch } };
      await expect(requestQuote(100, req, { relayed: relayed(body), now: NOW })).rejects.toMatchObject({
        code: "relay_mismatch",
        message: expect.stringContaining("not the answer to this request"),
      });
    };
    await refused({ sellToken: WXDAI });
    await refused({ buyToken: EURE });
    await refused({ receiver: getAddress("0x0000000000000000000000000000000000000001") });
    await refused({ from: getAddress("0x0000000000000000000000000000000000000001") }, true);
    await refused({ kind: "buy" });
    await refused({ appDataHash: `0x${"00".repeat(32)}` });
    await refused({ sellAmount: "9999999955492985178" }); // + fee ≠ what was asked
    await refused({ feeAmount: "0" });
    await expect(
      requestQuote(100, req, { relayed: relayed(ANSWER), now: new Date("2026-11-04T17:24:12Z") }), // past the orderbook's expiry
    ).rejects.toMatchObject({ code: "quote_moved" });
    // Missing echo fields are a shape error, not a pass.
    const { from: _from, ...noFrom } = ANSWER;
    void _from;
    await expect(requestQuote(100, req, { relayed: relayed(noFrom), now: NOW })).rejects.toMatchObject({ code: "cow_api" });
    expect(calls).toHaveLength(0);
  });

  it("the orderbook's refusal of the amount is taken from the browser: 400 → quote_failed, no call", async () => {
    noFetch();
    await expect(
      requestQuote(100, req, { relayed: relayed({ errorType: "NoLiquidity" }, 400), now: NOW }),
    ).rejects.toMatchObject({ code: "quote_failed" });
    expect(calls).toHaveLength(0);
  });

  it("anything else the browser brings back (its own 429, a WAF page, a 5xx) is the browser's trouble: the server asks itself", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (const bad of [relayed(THROTTLED, 429), { status: 403, text: "<html>Attention Required! | Cloudflare" }, { status: 502, text: "<html>bad gateway" }]) {
        stubFetch(() => json(200, ANSWER));
        await expect(requestQuote(100, req, { relayed: bad, now: NOW })).resolves.toMatchObject({ id: 255834133 });
        expect(calls).toHaveLength(1);
        expect(calls[0].url).toBe("https://api.cow.fi/xdai/api/v1/quote");
      }
      expect(warn).toHaveBeenCalledTimes(3);
      expect(String(warn.mock.calls[0][0])).toContain("HTTP 429");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("retryAfterMs", () => {
  it("seconds, an HTTP date, nothing readable, and nothing worth waiting for", () => {
    const now = Date.parse("2026-11-04T17:00:00Z");
    expect(retryAfterMs("2", now)).toBe(2_000);
    expect(retryAfterMs(" 0 ", now)).toBe(0);
    expect(retryAfterMs("Wed, 04 Nov 2026 17:00:05 GMT", now)).toBe(5_000);
    expect(retryAfterMs("Wed, 04 Nov 2026 16:59:00 GMT", now)).toBeNull();
    expect(retryAfterMs("soon", now)).toBeNull();
    expect(retryAfterMs("", now)).toBeNull();
    expect(retryAfterMs(null, now)).toBeNull();
    expect(retryAfterMs("30", now)).toBe(30_000); // the cap is send()'s decision, not the parser's
  });
});

describe("getOrder / getTrades never wait on a 429", () => {
  it("a throttled read is rate_limited at once (the Safe page and the cron are behind it)", async () => {
    vi.useFakeTimers();
    try {
      stubFetch(() => json(429, THROTTLED));
      const p = getOrder(100, UID);
      const expectation = expect(p).rejects.toMatchObject({ code: "rate_limited" });
      await vi.advanceTimersByTimeAsync(0);
      await expectation;
      expect(calls).toHaveLength(1);
      const t = getTrades(100, UID);
      const expectation2 = expect(t).rejects.toMatchObject({ code: "rate_limited" });
      await vi.advanceTimersByTimeAsync(0);
      await expectation2;
      expect(calls).toHaveLength(2); // one request each, no retry
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("postPreSignOrder", () => {
  const args = { chainId: 100, order: ORDER, owner: SAFE, appDataDoc: APP_DATA_DOC, uid: UID };

  it("posts the fee-less order with the owner as its signature and checks the uid answered", async () => {
    stubFetch(() => json(201, UID));
    await postPreSignOrder(args);
    expect(calls[0].url).toBe("https://api.cow.fi/xdai/api/v1/orders");
    expect(bodyOf(calls[0])).toMatchObject({
      sellToken: EURE,
      buyToken: WXDAI,
      receiver: SAFE,
      sellAmount: "500000000000000000",
      buyAmount: "557364217142754180",
      feeAmount: "0",
      kind: "sell",
      partiallyFillable: false,
      appData: APP_DATA_DOC,
      appDataHash: APP_DATA_HASH,
      from: SAFE,
      signingScheme: "presign",
      signature: SAFE,
    });
  });

  it("refuses an answered uid that is not the one computed (the fields differ from what was hashed)", async () => {
    stubFetch(() => json(201, `0x${"ab".repeat(56)}`));
    await expect(postPreSignOrder(args)).rejects.toMatchObject({ code: "cow_api" });
  });

  it("an order the orderbook already has is ours: fine", async () => {
    stubFetch(() => json(400, { errorType: "DuplicatedOrder", description: "order already exists" }));
    await expect(postPreSignOrder(args)).resolves.toBeUndefined();
  });

  it("retries one 429 after a pause (the throttle is per owner, a longer wait never helps); a second is rate_limited", async () => {
    vi.useFakeTimers();
    try {
      stubFetch((_url, _init, n) => (n === 1 ? json(429, { error: "rate limit" }) : json(201, UID)));
      const p = postPreSignOrder(args);
      await vi.advanceTimersByTimeAsync(2_000);
      await expect(p).resolves.toBeUndefined();
      expect(calls).toHaveLength(2);

      stubFetch(() => json(429, { error: "rate limit" }));
      const q = postPreSignOrder(args);
      const expectation = expect(q).rejects.toMatchObject({ code: "rate_limited" });
      await vi.advanceTimersByTimeAsync(6_000);
      await expectation;
      expect(calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("any other refusal is cow_api with the orderbook's words", async () => {
    stubFetch(() => json(400, { errorType: "InsufficientBalance", description: "insufficient balance" }));
    await expect(postPreSignOrder(args)).rejects.toMatchObject({
      code: "cow_api",
      message: expect.stringContaining("InsufficientBalance"),
    });
  });

  describe("posted by the browser (preparedOrderRequest → answer)", () => {
    const answered = (body: unknown, status = 201) => ({ status, text: JSON.stringify(body) });
    const noFetch = () => stubFetch(() => Promise.reject(new Error("the server must not call out")));

    it("the prepared post is the post the server would make, byte for byte", async () => {
      stubFetch(() => json(201, UID));
      await postPreSignOrder(args);
      expect(preparedOrderRequest(args)).toEqual({
        method: "POST",
        url: "https://api.cow.fi/xdai/api/v1/orders",
        headers: { "content-type": "application/json" },
        body: String(calls[0].init?.body),
      });
    });

    it("reads the uid answered without a call; a wrong uid, or DuplicatedOrder, as from the server", async () => {
      noFetch();
      await expect(postPreSignOrder(args, answered(UID))).resolves.toBeUndefined();
      await expect(postPreSignOrder(args, answered(`0x${"ab".repeat(56)}`))).rejects.toMatchObject({ code: "cow_api" });
      await expect(postPreSignOrder(args, answered({ errorType: "DuplicatedOrder" }, 400))).resolves.toBeUndefined();
      await expect(postPreSignOrder(args, answered({ errorType: "InsufficientBalance" }, 400))).rejects.toMatchObject({ code: "cow_api" });
      expect(calls).toHaveLength(0);
    });

    it("an answer that is not the orderbook's (the browser's 429, a WAF page) → the server posts", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        for (const bad of [answered(THROTTLED, 429), { status: 403, text: "<html>Attention Required!" }]) {
          stubFetch(() => json(201, UID));
          await expect(postPreSignOrder(args, bad)).resolves.toBeUndefined();
          expect(calls).toHaveLength(1);
          expect(calls[0].url).toBe("https://api.cow.fi/xdai/api/v1/orders");
        }
        expect(warn).toHaveBeenCalledTimes(2);
      } finally {
        warn.mockRestore();
      }
    });
  });
});

describe("getOrder / getTrades", () => {
  it("parses an order, null on 404, refuses an unknown status", async () => {
    stubFetch(() =>
      json(200, { uid: UID, status: "fulfilled", executedSellAmount: "500000000000000000", executedBuyAmount: "560166047667388179", invalidated: false, validTo: 1794295416 }),
    );
    expect(await getOrder(100, UID)).toEqual({
      uid: UID,
      status: "fulfilled",
      executedSellAmount: BigInt("500000000000000000"),
      executedBuyAmount: BigInt("560166047667388179"),
      invalidated: false,
      validTo: 1794295416,
    });
    expect(calls[0].url).toBe(`https://api.cow.fi/xdai/api/v1/orders/${UID}`);
    stubFetch(() => json(404, { errorType: "OrderNotFound" }));
    expect(await getOrder(100, UID)).toBeNull();
    stubFetch(() => json(200, { uid: UID, status: "teleported", executedSellAmount: "0", executedBuyAmount: "0", validTo: 1 }));
    await expect(getOrder(100, UID)).rejects.toMatchObject({ code: "cow_api" });
  });

  it("parses the trades of an order", async () => {
    stubFetch(() =>
      json(200, [
        { orderUid: UID, owner: SAFE.toLowerCase(), sellAmount: "500000000000000000", buyAmount: "560166047667388179", txHash: `0x${"9e".repeat(32)}`, blockNumber: 49084770, logIndex: 3 },
      ]),
    );
    const trades = await getTrades(100, UID);
    expect(trades).toEqual([
      { orderUid: UID, owner: SAFE, sellAmount: BigInt("500000000000000000"), buyAmount: BigInt("560166047667388179"), txHash: `0x${"9e".repeat(32)}`, blockNumber: 49084770, logIndex: 3 },
    ]);
    expect(calls[0].url).toBe(`https://api.cow.fi/xdai/api/v1/trades?orderUid=${UID}`);
    stubFetch(() => json(200, { not: "an array" }));
    await expect(getTrades(100, UID)).rejects.toMatchObject({ code: "cow_api" });
  });
});
