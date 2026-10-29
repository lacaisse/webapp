// SPDX-License-Identifier: AGPL-3.0-or-later
import { encodeAbiParameters, stringToHex } from "viem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { Erc20MetadataError, readErc20Metadata } from "./erc20-metadata";

// Alchemy JSON-RPC stubbed at the fetch layer: eth_getCode, then eth_call by
// selector (decimals / symbol / name).
const USDCE = "0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0";
const DECIMALS = "0x313ce567";
const SYMBOL = "0x95d89b41";
const NAME = "0x06fdde03";

type Reply = { result: string } | { error: { code: number; message: string } };
type Calls = Partial<Record<string, Reply>>;

const word = (n: number) => encodeAbiParameters([{ type: "uint256" }], [BigInt(n)]);
const str = (s: string) => encodeAbiParameters([{ type: "string" }], [s]);
const reverted: Reply = { error: { code: 3, message: "execution reverted" } };

function stubRpc(code: string, calls: Calls) {
  const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      method: string;
      params: [{ to: string; data: string } | string, string];
    };
    let reply: Reply;
    if (body.method === "eth_getCode") reply = { result: code };
    else if (body.method === "eth_call") {
      const data = (body.params[0] as { data: string }).data;
      reply = calls[data] ?? reverted;
    } else throw new Error(`unexpected ${body.method}`);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, ...reply }), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.stubEnv("ALCHEMY_API_KEY", "test-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("readErc20Metadata", () => {
  it("reads symbol, name and decimals and checksums the address", async () => {
    const fetchMock = stubRpc("0x6080", {
      [DECIMALS]: { result: word(6) },
      [SYMBOL]: { result: str("USDC.e") },
      [NAME]: { result: str("Bridged USDC (Gnosis)") },
    });

    const meta = await readErc20Metadata(100, USDCE.toLowerCase());

    expect(meta).toEqual({
      address: USDCE,
      symbol: "USDC.e",
      name: "Bridged USDC (Gnosis)",
      decimals: 6,
    });
    expect(fetchMock.mock.calls[0][0]).toBe("https://gnosis-mainnet.g.alchemy.com/v2/test-key");
    const first = JSON.parse(String(fetchMock.mock.calls[0][1].body));
    expect(first).toMatchObject({ method: "eth_getCode", params: [USDCE, "latest"] });
  });

  it("accepts a legacy bytes32 symbol and falls back to the symbol for a missing name", async () => {
    stubRpc("0x6080", {
      [DECIMALS]: { result: word(18) },
      [SYMBOL]: { result: stringToHex("MKR", { size: 32 }) },
      // name() reverts
    });
    const meta = await readErc20Metadata(100, USDCE);
    expect(meta).toMatchObject({ symbol: "MKR", name: "MKR", decimals: 18 });
  });

  it("refuses an address with no code", async () => {
    stubRpc("0x", {});
    const err = await readErc20Metadata(100, USDCE).catch((e) => e);
    expect(err).toBeInstanceOf(Erc20MetadataError);
    expect(err).toMatchObject({ code: "not_erc20" });
  });

  it("refuses a contract whose decimals() reverts or returns garbage", async () => {
    stubRpc("0x6080", { [SYMBOL]: { result: str("SAFE") } });
    await expect(readErc20Metadata(100, USDCE)).rejects.toMatchObject({ code: "not_erc20" });

    stubRpc("0x6080", {
      [DECIMALS]: { result: "0x" },
      [SYMBOL]: { result: str("X") },
    });
    await expect(readErc20Metadata(100, USDCE)).rejects.toMatchObject({ code: "not_erc20" });

    stubRpc("0x6080", {
      [DECIMALS]: { result: word(1000) }, // not a uint8
      [SYMBOL]: { result: str("X") },
    });
    await expect(readErc20Metadata(100, USDCE)).rejects.toMatchObject({ code: "not_erc20" });
  });

  it("refuses a token without a symbol", async () => {
    stubRpc("0x6080", { [DECIMALS]: { result: word(6) } });
    await expect(readErc20Metadata(100, USDCE)).rejects.toMatchObject({ code: "not_erc20" });
  });

  it("lets transport failures through (not read as 'not an ERC-20')", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad gateway", { status: 502 })),
    );
    const err = await readErc20Metadata(100, USDCE).catch((e) => e);
    expect(err).not.toBeInstanceOf(Erc20MetadataError);
    expect(String(err)).toContain("HTTP 502");
  });

  it("refuses a chain without an RPC", async () => {
    await expect(readErc20Metadata(424242, USDCE)).rejects.toMatchObject({
      code: "unsupported_chain",
    });
  });
});
