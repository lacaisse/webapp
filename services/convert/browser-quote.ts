// SPDX-License-Identifier: AGPL-3.0-or-later

import type { PreparedHttp, RelayedHttp } from "./types";

// The holder's browser fetches the swap quote itself. The CoW orderbook
// rate-limits per IP and answers CORS from any origin; the server's shared
// cloud egress (Vercel) finds that limit spent by other tenants' traffic,
// the admin's own address has it to itself. The server prepares the exact
// request (prepareQuoteAction) and parses and checks the exact answer
// (cow-api.ts requestQuote `relayed`): the browser carries bytes, decides
// nothing. Null when it cannot (offline, blocked by an extension, slow):
// the server then calls out as before. Client-safe: no server-only.
// Module map: services/convert/assets.ts.

const TIMEOUT_MS = 10_000;

export async function relayQuote(req: PreparedHttp): Promise<RelayedHttp | null> {
  try {
    const res = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      mode: "cors",
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { status: res.status, text: await res.text() };
  } catch {
    return null;
  }
}
