// SPDX-License-Identifier: AGPL-3.0-or-later
import { decodeFunctionData, getAddress, toFunctionSelector } from "viem";
import { describe, expect, it } from "vitest";

import { BREAD_CONTRACTS_BY_CHAIN, GNOSIS_ASSETS } from "../assets";
import type { LegContext } from "../types";
import { breadBurn, breadMint } from "./bread";

const { bread, wxdai } = BREAD_CONTRACTS_BY_CHAIN[100];
const SAFE = getAddress("0x5afe00000000000000000000000000000000cafe");
const NOW = new Date("2026-11-02T12:00:00Z");
const X = BigInt("55800000000000000000"); // 55.8 xDAI

const BREAD_ABI = [
  { type: "function", name: "mint", stateMutability: "payable", inputs: [{ name: "receiver", type: "address" }], outputs: [] },
  {
    type: "function",
    name: "burn",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "receiver", type: "address" },
    ],
    outputs: [],
  },
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ name: "wad", type: "uint256" }], outputs: [] },
] as const;

function ctx(results: LegContext["results"] = []): LegContext {
  return {
    chainId: 100,
    holder: SAFE,
    amountIn: X,
    quote: { amountIn: X, amountOut: X, minAmountOut: X, validUntil: new Date(NOW.getTime() + 7 * 86_400_000) },
    results,
    now: NOW,
  };
}

describe("BREAD legs", () => {
  it("are exact 1:1 quotes valid for the requested window", async () => {
    for (const leg of [breadMint, breadBurn]) {
      const q = await leg.quote({ chainId: 100, holder: SAFE, amountIn: X, slippageBps: 50, validFor: 600, now: NOW });
      expect(q).toEqual({ amountIn: X, amountOut: X, minAmountOut: X, validUntil: new Date(NOW.getTime() + 600_000) });
      expect(leg.exact).toBe(true);
      await expect(leg.quote({ chainId: 100, holder: SAFE, amountIn: BigInt(0), slippageBps: 50, validFor: 600, now: NOW })).rejects.toMatchObject({ code: "amount" });
      await expect(leg.quote({ chainId: 1, holder: SAFE, amountIn: X, slippageBps: 50, validFor: 600, now: NOW })).rejects.toMatchObject({ code: "config" });
      expect(() => leg.contracts(1)).toThrow(expect.objectContaining({ code: "config" }));
    }
    // Each leg may only call the one function it uses on each contract.
    expect(breadMint.contracts(100)).toEqual([
      { address: wxdai, selectors: [toFunctionSelector("function withdraw(uint256)")] },
      { address: bread, selectors: [toFunctionSelector("function mint(address)")] },
    ]);
    expect(breadBurn.contracts(100)).toEqual([
      { address: bread, selectors: [toFunctionSelector("function burn(uint256,address)")] },
      { address: wxdai, selectors: [toFunctionSelector("function deposit()")] },
    ]);
    expect(breadMint.from).toBe(GNOSIS_ASSETS.WXDAI);
    expect(breadMint.to).toBe(GNOSIS_ASSETS.BREAD);
    expect(breadBurn.from).toBe(GNOSIS_ASSETS.BREAD);
    expect(breadBurn.to).toBe(GNOSIS_ASSETS.WXDAI);
  });

  it("mint: unwrap the WXDAI, then mint BREAD with that xDAI to the holder", () => {
    const step = breadMint.next(ctx());
    expect(step?.kind).toBe("calls");
    if (step?.kind !== "calls") throw new Error("unreachable");
    expect(step.calls.map((c) => [c.to, c.value, c.label])).toEqual([
      [wxdai, BigInt(0), "unwrap"],
      [bread, X, "mint"],
    ]);
    expect(decodeFunctionData({ abi: BREAD_ABI, data: step.calls[0].data })).toEqual({ functionName: "withdraw", args: [X] });
    expect(decodeFunctionData({ abi: BREAD_ABI, data: step.calls[1].data })).toEqual({ functionName: "mint", args: [SAFE] });
    expect(breadMint.output(ctx())).toBeNull();
    const done = ctx([{ kind: "calls", txHash: "0xabc" }]);
    expect(breadMint.next(done)).toBeNull();
    expect(breadMint.output(done)).toBe(X);
  });

  it("burn: burn BREAD for xDAI to the holder, then wrap it", () => {
    const step = breadBurn.next(ctx());
    if (step?.kind !== "calls") throw new Error("expected calls");
    expect(step.calls.map((c) => [c.to, c.value, c.label])).toEqual([
      [bread, BigInt(0), "burn"],
      [wxdai, X, "wrap"],
    ]);
    expect(decodeFunctionData({ abi: BREAD_ABI, data: step.calls[0].data })).toEqual({ functionName: "burn", args: [X, SAFE] });
    expect(decodeFunctionData({ abi: BREAD_ABI, data: step.calls[1].data })).toEqual({ functionName: "deposit", args: undefined });
    const done = ctx([{ kind: "calls", txHash: null }]);
    expect(breadBurn.next(done)).toBeNull();
    expect(breadBurn.output(done)).toBe(X);
  });
});
