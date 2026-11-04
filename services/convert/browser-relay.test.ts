// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from "vitest";

import { relayRequest } from "./browser-relay";
import { RELAYED_TEXT_MAX } from "./schemas";

// The client half of the browser relay (quote and order post): the exact request goes out, the
// status and body come back unchanged (cut to what the server reads), and
// anything that keeps the browser from an answer is null — the server then
// asks for itself.

const REQ = {
  method: "POST" as const,
  url: "https://api.cow.fi/xdai/api/v1/quote",
  headers: { "content-type": "application/json" },
  body: '{"kind":"sell"}',
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("relayRequest", () => {
  it("sends the prepared request as is and brings back the status and body", async () => {
    const fetch = vi.fn(async () => new Response('{"quote":{}}', { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    expect(await relayRequest(REQ)).toEqual({ status: 200, text: '{"quote":{}}' });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(REQ.url);
    expect(init).toMatchObject({ method: "POST", headers: REQ.headers, body: REQ.body, mode: "cors", credentials: "omit" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("brings back a refusal too, cut to what the server will read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("x".repeat(RELAYED_TEXT_MAX + 5_000), { status: 403 })));
    const r = await relayRequest(REQ);
    expect(r?.status).toBe(403);
    expect(r?.text).toHaveLength(RELAYED_TEXT_MAX);
  });

  it("is null when the browser cannot fetch, or the body cannot be read", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    expect(await relayRequest(REQ)).toBeNull();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ status: 200, text: () => Promise.reject(new Error("body stream broke")) })),
    );
    expect(await relayRequest(REQ)).toBeNull();
  });

  it("is null once the timeout aborts the request", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) => {
            init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          }),
      ),
    );
    const p = relayRequest(REQ, 1_000);
    await vi.advanceTimersByTimeAsync(999);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toBeNull();
  });
});
