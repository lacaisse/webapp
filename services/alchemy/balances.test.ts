// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getNativeBalances } from "./balances";

const A = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

type RpcBody = { method: string; params: unknown[] };

let calls: RpcBody[] = [];

function stubFetch(balances: Record<string, string>) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe("https://gnosis-mainnet.g.alchemy.com/v2/test-key");
      const body = JSON.parse(String(init.body)) as RpcBody;
      calls.push(body);
      const addr = String(body.params[0]);
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: balances[addr] ?? "0x0" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );
}

beforeEach(() => {
  calls = [];
  vi.stubEnv("ALCHEMY_API_KEY", "test-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("getNativeBalances", () => {
  it("reads eth_getBalance once per distinct address, rows in input order", async () => {
    stubFetch({ [A.toLowerCase()]: "0xde0b6b3a7640000", [B]: "0x1" });
    const rows = await getNativeBalances({ chainId: 100, addresses: [A, B, A] });
    expect(rows).toEqual([
      { address: A.toLowerCase(), rawBalance: "0xde0b6b3a7640000" },
      { address: B, rawBalance: "0x1" },
      { address: A.toLowerCase(), rawBalance: "0xde0b6b3a7640000" },
    ]);
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.method).toBe("eth_getBalance");
      expect(c.params[1]).toBe("latest");
    }
  });

  it("returns [] without any RPC for no addresses", async () => {
    stubFetch({});
    expect(await getNativeBalances({ chainId: 100, addresses: [] })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("throws on an unsupported chain and on an RPC error", async () => {
    stubFetch({});
    await expect(getNativeBalances({ chainId: 999, addresses: [A] })).rejects.toThrow(
      /unsupported chain/,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: { message: "boom" } }), { status: 200 }),
      ),
    );
    await expect(getNativeBalances({ chainId: 100, addresses: [B] })).rejects.toThrow(
      /boom/,
    );
  });
});
