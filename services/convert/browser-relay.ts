// SPDX-License-Identifier: AGPL-3.0-or-later

import { RELAYED_TEXT_MAX } from "./schemas";
import type { PreparedHttp, RelayedHttp } from "./types";

// The holder's browser makes the orderbook calls a conversion needs on its
// way to a proposal — the quote, then the order post. The CoW orderbook
// rate-limits per IP and answers CORS from any origin; the server's shared
// cloud egress (Vercel) finds that limit spent by other tenants' traffic,
// the admin's own address has it to itself. The server prepares the exact
// request (prepareQuoteAction, the start action's relay) and parses and
// checks the exact answer (cow-api.ts requestQuote / postPreSignOrder with
// a relayed answer): the browser carries bytes, decides nothing. Null when
// it cannot (offline, blocked by an extension, slow): the server then calls
// out as before — as it also does when the answer is not the orderbook's
// (a 429 on the browser's IP, a WAF page, a 5xx). Client-safe: no
// server-only. Module map: services/convert/assets.ts.

const TIMEOUT_MS = 10_000;

export async function relayRequest(req: PreparedHttp, timeoutMs = TIMEOUT_MS): Promise<RelayedHttp | null> {
  // AbortController rather than AbortSignal.timeout: the latter is missing
  // on older WebKit, which would silently keep those admins off this path.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      signal: controller.signal,
    });
    const text = await res.text();
    // An error page can be long; the server reads only what it would parse.
    return { status: res.status, text: text.slice(0, RELAYED_TEXT_MAX) };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
