// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import {
  ShapeError,
  addr,
  hex,
  int,
  obj,
  shaped as shapedWith,
  str,
  uint,
} from "@/services/http/shape";

import { orderToJson, type CowOrder } from "./cow-order";
import { ConvertError, type Address, type Hex } from "./types";

// CoW Protocol orderbook — the few calls the swap leg needs, plain fetch, no
// SDK (built like services/safe/tx-service.ts). Module map:
// services/convert/assets.ts.
//
//   POST /api/v1/quote           → price for selling an exact amount
//   POST /api/v1/orders          → post a pre-sign order (body = the order
//                                  + owner; answers the uid)
//   GET  /api/v1/orders/{uid}    → status, executed amounts
//   GET  /api/v1/trades?orderUid → the fills (one for a fill-or-kill order)
//
// `COW_API_URL` overrides the base (a mock in dev / tests); otherwise the
// hosted orderbook for the chain. 10 s timeout per request.

const TIMEOUT_MS = 10_000;
// The hosted orderbook rate-limits per IP (quotes 10/s, orders 5/s, reads
// 100/min, and a WAF that is stricter still on /quote), and separately
// throttles order creation per owner. This app runs on shared cloud egress
// (Vercel), so a single quote can meet a 429 that other tenants' traffic
// earned: the orderbook answers with its x402 pay-per-quote pitch. CoW's own
// guidance is to honour Retry-After and retry a few times; after that the
// caller hears `rate_limited` — a quota, not an outage.
const RETRY_429_ATTEMPTS = 3; // requests in all, the first included
const RETRY_429_BACKOFF_MS = [2_000, 4_000]; // when no Retry-After is sent
const RETRY_AFTER_MAX_MS = 10_000; // a longer Retry-After is not worth the wait

const COW_API_BY_CHAIN: Record<number, string> = {
  100: "https://api.cow.fi/xdai",
};

export function cowApiBaseUrl(chainId: number): string | null {
  const override = process.env.COW_API_URL?.trim();
  if (override) return override.replace(/\/+$/, "");
  return COW_API_BY_CHAIN[chainId] ?? null;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

type HttpResult = { status: number; text: string; retryAfterMs: number | null };

async function sendOnce(
  chainId: number,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<HttpResult> {
  const base = cowApiBaseUrl(chainId);
  if (!base) throw new ConvertError("config", `No CoW orderbook for chain ${chainId}`);
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new ConvertError("cow_api", `${method} ${path} failed: ${reason}`, { cause: e });
  }
  return {
    status: res.status,
    text: await res.text().catch(() => ""),
    retryAfterMs: retryAfterMs(res.headers.get("retry-after")),
  };
}

// Retry-After is seconds or an HTTP date; anything unreadable, negative or
// longer than we care to wait counts as not sent.
export function retryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header) return null;
  const h = header.trim();
  let ms: number;
  if (/^\d+$/.test(h)) ms = Number(h) * 1000;
  else {
    const at = Date.parse(h);
    if (Number.isNaN(at)) return null;
    ms = at - now;
  }
  if (ms < 0 || ms > RETRY_AFTER_MAX_MS) return null;
  return ms;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `sendOnce`, retried through 429s; still 429 after the last attempt → rate_limited. */
async function send(
  chainId: number,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<HttpResult> {
  let r = await sendOnce(chainId, method, path, body);
  for (let attempt = 1; r.status === 429 && attempt < RETRY_429_ATTEMPTS; attempt++) {
    const backoff = RETRY_429_BACKOFF_MS[Math.min(attempt, RETRY_429_BACKOFF_MS.length) - 1];
    await sleep(r.retryAfterMs ?? backoff);
    r = await sendOnce(chainId, method, path, body);
  }
  if (r.status === 429) {
    throw new ConvertError("rate_limited", `${method} ${path} HTTP 429: ${r.text.slice(0, 300)}`);
  }
  return r;
}

function httpError(method: string, path: string, r: HttpResult): ConvertError {
  return new ConvertError("cow_api", `${method} ${path} HTTP ${r.status}: ${r.text.slice(0, 300)}`);
}

function parseJson(method: string, path: string, r: HttpResult): unknown {
  try {
    return JSON.parse(r.text);
  } catch {
    throw new ConvertError("cow_api", `${method} ${path}: response is not JSON`);
  }
}

// ---------------------------------------------------------------------------
// Shape parsing (helpers: services/http/shape.ts)
// ---------------------------------------------------------------------------

function shaped<T>(what: string, f: () => T): T {
  return shapedWith(
    f,
    (e) => new ConvertError("cow_api", `CoW orderbook: unexpected ${what} (${e.message})`),
  );
}

// ---------------------------------------------------------------------------
// Quote
// ---------------------------------------------------------------------------

export type CowQuoteRequest = {
  sellToken: Address;
  buyToken: Address;
  owner: Address; // `from` and `receiver`: the account that sells and receives
  sellAmountBeforeFee: bigint;
  appDataDoc: string;
  appDataHash: Hex;
  validFor: number; // seconds
};

export type CowQuote = {
  sellAmount: bigint; // after the fee
  feeAmount: bigint;
  buyAmount: bigint;
  validTo: number;
  expiration: Date; // when the quote itself stops being honoured
  id: number | null;
};

export async function requestQuote(chainId: number, q: CowQuoteRequest): Promise<CowQuote> {
  const path = "/api/v1/quote";
  const r = await send(chainId, "POST", path, {
    sellToken: q.sellToken,
    buyToken: q.buyToken,
    receiver: q.owner,
    from: q.owner,
    kind: "sell",
    sellAmountBeforeFee: q.sellAmountBeforeFee.toString(),
    signingScheme: "presign",
    onchainOrder: false,
    priceQuality: "optimal",
    validFor: q.validFor,
    appData: q.appDataDoc,
    appDataHash: q.appDataHash,
  });
  if (r.status < 200 || r.status >= 300) {
    // No route / too small / unsupported token: a quote problem, not an outage.
    if (r.status === 400 || r.status === 404) {
      throw new ConvertError("quote_failed", `POST ${path} HTTP ${r.status}: ${r.text.slice(0, 300)}`);
    }
    throw httpError("POST", path, r);
  }
  const json = parseJson("POST", path, r);
  return shaped("quote", () => {
    const o = obj(json, "quote response");
    const quote = obj(o.quote, "quote");
    const expiration = new Date(str(o.expiration, "expiration"));
    if (Number.isNaN(expiration.getTime())) throw new ShapeError("expiration is not a date");
    return {
      sellAmount: uint(quote.sellAmount, "sellAmount"),
      feeAmount: uint(quote.feeAmount, "feeAmount"),
      buyAmount: uint(quote.buyAmount, "buyAmount"),
      validTo: int(quote.validTo, "validTo"),
      expiration,
      id: typeof o.id === "number" ? o.id : null,
    };
  });
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

/**
 * Post a pre-sign order. `uid` is the locally computed uid (cow-order.ts):
 * the orderbook must answer the same one, and an order it already has
 * (DuplicatedOrder) is fine — it is ours.
 */
export async function postPreSignOrder(a: {
  chainId: number;
  order: CowOrder;
  owner: Address;
  appDataDoc: string;
  uid: Hex;
}): Promise<void> {
  const path = "/api/v1/orders";
  const body = {
    ...orderToJson(a.order),
    appData: a.appDataDoc,
    appDataHash: a.order.appData,
    from: a.owner,
    signingScheme: "presign",
    signature: a.owner,
  };
  const r = await send(a.chainId, "POST", path, body);
  if (r.status >= 200 && r.status < 300) {
    const json = parseJson("POST", path, r);
    const answered = shaped("order uid", () => hex(json, "uid"));
    if (answered.toLowerCase() !== a.uid.toLowerCase()) {
      throw new ConvertError(
        "cow_api",
        `CoW orderbook answered uid ${answered}, expected ${a.uid}: order fields differ from what we hashed`,
      );
    }
    return;
  }
  if (r.status === 400 && /DuplicatedOrder/.test(r.text)) return;
  throw httpError("POST", path, r);
}

export type CowOrderStatus = "presignaturePending" | "open" | "fulfilled" | "cancelled" | "expired";

export type CowOrderView = {
  uid: Hex;
  status: CowOrderStatus;
  executedSellAmount: bigint;
  executedBuyAmount: bigint;
  invalidated: boolean;
  validTo: number;
};

const ORDER_STATUSES = new Set<string>([
  "presignaturePending",
  "open",
  "fulfilled",
  "cancelled",
  "expired",
]);

export async function getOrder(chainId: number, uid: Hex): Promise<CowOrderView | null> {
  const path = `/api/v1/orders/${uid}`;
  const r = await send(chainId, "GET", path);
  if (r.status === 404) return null;
  if (r.status < 200 || r.status >= 300) throw httpError("GET", path, r);
  const json = parseJson("GET", path, r);
  return shaped("order", () => {
    const o = obj(json, "order");
    const status = str(o.status, "status");
    if (!ORDER_STATUSES.has(status)) throw new ShapeError(`unknown status ${status}`);
    return {
      uid: hex(o.uid, "uid"),
      status: status as CowOrderStatus,
      executedSellAmount: uint(o.executedSellAmount, "executedSellAmount"),
      executedBuyAmount: uint(o.executedBuyAmount, "executedBuyAmount"),
      invalidated: o.invalidated === true,
      validTo: int(o.validTo, "validTo"),
    };
  });
}

export type CowTrade = {
  orderUid: Hex;
  owner: Address;
  sellAmount: bigint;
  buyAmount: bigint;
  txHash: Hex;
  blockNumber: number;
  logIndex: number;
};

export async function getTrades(chainId: number, uid: Hex): Promise<CowTrade[]> {
  const path = `/api/v1/trades?orderUid=${uid}`;
  const r = await send(chainId, "GET", path);
  if (r.status < 200 || r.status >= 300) throw httpError("GET", path, r);
  const json = parseJson("GET", path, r);
  return shaped("trades", () => {
    if (!Array.isArray(json)) throw new ShapeError("trades is not an array");
    return json.map((t, i) => {
      const o = obj(t, `trade ${i}`);
      return {
        orderUid: hex(o.orderUid, "orderUid"),
        owner: addr(o.owner, "owner"),
        sellAmount: uint(o.sellAmount, "sellAmount"),
        buyAmount: uint(o.buyAmount, "buyAmount"),
        txHash: hex(o.txHash, "txHash"),
        blockNumber: int(o.blockNumber, "blockNumber"),
        logIndex: int(o.logIndex, "logIndex"),
      };
    });
  });
}
