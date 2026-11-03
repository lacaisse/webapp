// SPDX-License-Identifier: AGPL-3.0-or-later
import { getAddress } from "viem";
import { describe, expect, it } from "vitest";

import { GNOSIS_ASSETS } from "./assets";
import { breadBurn, breadMint } from "./legs/bread";
import {
  legQuoteToJson,
  type Converter,
  type ConversionState,
  type Erc20AssetId,
  type Leg,
  type StepResult,
} from "./types";
import { assertConverter, converterContracts, quoteChain, walk } from "./walk";

// The walk is exercised with the real BREAD legs and a stand-in swap leg
// that behaves like the CoW one (api → calls → wait) without the orderbook.
const SAFE = getAddress("0x5afe00000000000000000000000000000000cafe");
const SELL = getAddress("0x1111111111111111111111111111111111111111");
const SETTLE = getAddress("0x2222222222222222222222222222222222222222");
const APPROVE = "0x095ea7b3";
const PRESIGN = "0xec6cb13f";
const NOW = new Date("2026-11-02T12:00:00Z");
const IN = BigInt("50000000000000000000"); // 50 EURe
const QUOTED = BigInt("56000000000000000000"); // 56 WXDAI expected
const FILLED = BigInt("55900000000000000000"); // what actually landed

function swapLeg(from: Erc20AssetId, to: Erc20AssetId): Leg {
  return {
    id: "swap-stub",
    from,
    to,
    exact: false,
    steps: ["api", "calls", "wait"],
    contracts: () => [
      { address: SELL, selectors: [APPROVE] },
      { address: SETTLE, selectors: [PRESIGN] },
    ],
    quote: async (r) => ({
      amountIn: r.amountIn,
      amountOut: QUOTED,
      minAmountOut: (QUOTED * BigInt(10_000 - r.slippageBps)) / BigInt(10_000),
      validUntil: new Date(r.now.getTime() + r.validFor * 1000),
    }),
    next: (c) => {
      if (!c.results.some((r) => r.kind === "api")) return { kind: "api", label: "post-order" };
      if (!c.results.some((r) => r.kind === "calls")) {
        return {
          kind: "calls",
          label: "swap",
          calls: [
            { to: SELL, value: BigInt(0), data: "0xa9", label: "approve" },
            { to: SETTLE, value: BigInt(0), data: "0xec", label: "presign" },
          ],
        };
      }
      if (!c.results.some((r) => r.kind === "wait")) return { kind: "wait", label: "fill" };
      return null;
    },
    output: (c) => {
      const w = c.results.find((r) => r.kind === "wait");
      return w ? BigInt(w.amountOut) : null;
    },
  };
}

const EURE_BREAD: Converter = { id: "eure-bread", legs: [swapLeg(GNOSIS_ASSETS.EURE, GNOSIS_ASSETS.WXDAI), breadMint] };
const BREAD_EURE: Converter = { id: "bread-eure", legs: [breadBurn, swapLeg(GNOSIS_ASSETS.WXDAI, GNOSIS_ASSETS.EURE)] };

async function freshState(converter: Converter): Promise<ConversionState> {
  const q = await quoteChain(converter, { chainId: 100, holder: SAFE, amountIn: IN, slippageBps: 50, validFor: 7 * 86_400, now: NOW });
  return { legs: q.legs.map((quote) => ({ quote: legQuoteToJson(quote), results: [] })) };
}

function at(converter: Converter, state: ConversionState) {
  return walk({ converter, chainId: 100, holder: SAFE, amountIn: IN, state, now: NOW });
}

function record(state: ConversionState, legs: number[], result: StepResult) {
  for (const i of legs) state.legs[i].results.push(result);
}

describe("quoteChain", () => {
  it("feeds each leg the previous expected output; the minimum passes through exact legs", async () => {
    const q = await quoteChain(EURE_BREAD, { chainId: 100, holder: SAFE, amountIn: IN, slippageBps: 50, validFor: 600, now: NOW });
    expect(q.legs.map((l) => [l.amountIn, l.amountOut])).toEqual([
      [IN, QUOTED],
      [QUOTED, QUOTED],
    ]);
    expect(q.expectedOut).toBe(QUOTED);
    expect(q.minOut).toBe((QUOTED * BigInt(9_950)) / BigInt(10_000));
    expect(q.validUntil).toEqual(new Date(NOW.getTime() + 600_000));

    const r = await quoteChain(BREAD_EURE, { chainId: 100, holder: SAFE, amountIn: IN, slippageBps: 100, validFor: 600, now: NOW });
    expect(r.legs[1].amountIn).toBe(IN); // burn is exact: the swap sells the full input
    expect(r.minOut).toBe((QUOTED * BigInt(9_900)) / BigInt(10_000));
  });
});

describe("walk: EURe → BREAD (swap, then exact mint)", () => {
  it("api → batch[approve, presign] → wait → batch[unwrap, mint] sized to the fill → done", async () => {
    const state = await freshState(EURE_BREAD);

    let w = at(EURE_BREAD, state);
    expect(w).toMatchObject({ done: false, position: { legIndex: 0, step: { kind: "api" }, appliesTo: [0], amountIn: IN } });
    record(state, [0], { kind: "api", ref: "0xuid" });

    w = at(EURE_BREAD, state);
    if (w.done) throw new Error("not done yet");
    expect(w.position.legIndex).toBe(0);
    expect(w.position.appliesTo).toEqual([0]);
    expect(w.position.step.kind).toBe("calls");
    if (w.position.step.kind !== "calls") throw new Error("unreachable");
    expect(w.position.step.calls.map((c) => c.label)).toEqual(["approve", "presign"]);
    record(state, w.position.appliesTo, { kind: "calls", txHash: "0x1" });

    w = at(EURE_BREAD, state);
    expect(w).toMatchObject({ done: false, position: { legIndex: 0, step: { kind: "wait" } } });
    record(state, [0], { kind: "wait", amountOut: FILLED.toString(), txHash: "0x2" });

    w = at(EURE_BREAD, state);
    if (w.done) throw new Error("mint still to do");
    expect(w.position.legIndex).toBe(1);
    expect(w.position.amountIn).toBe(FILLED); // the real fill, not the quote
    if (w.position.step.kind !== "calls") throw new Error("unreachable");
    expect(w.position.step.calls.map((c) => [c.label, c.value])).toEqual([
      ["unwrap", BigInt(0)],
      ["mint", FILLED],
    ]);
    record(state, w.position.appliesTo, { kind: "calls", txHash: "0x3" });

    expect(at(EURE_BREAD, state)).toEqual({ done: true, position: null, amountOut: FILLED });
  });
});

describe("walk: BREAD → EURe (exact burn folds into the swap's batch)", () => {
  it("api first, then ONE batch[burn, wrap, approve, presign] recorded on both legs, then wait → done", async () => {
    const state = await freshState(BREAD_EURE);

    // The burn's calls are held; the swap's api step goes first.
    let w = at(BREAD_EURE, state);
    expect(w).toMatchObject({ done: false, position: { legIndex: 1, step: { kind: "api" }, appliesTo: [1], amountIn: IN } });
    record(state, [1], { kind: "api", ref: "0xuid" });

    w = at(BREAD_EURE, state);
    if (w.done) throw new Error("not done yet");
    expect(w.position.legIndex).toBe(1);
    expect(w.position.appliesTo).toEqual([0, 1]);
    if (w.position.step.kind !== "calls") throw new Error("unreachable");
    expect(w.position.step.calls.map((c) => c.label)).toEqual(["burn", "wrap", "approve", "presign"]);
    expect(w.position.step.calls[1].value).toBe(IN); // wrap carries the burnt xDAI
    record(state, w.position.appliesTo, { kind: "calls", txHash: "0x1" });

    w = at(BREAD_EURE, state);
    expect(w).toMatchObject({ done: false, position: { legIndex: 1, step: { kind: "wait" } } });
    record(state, [1], { kind: "wait", amountOut: FILLED.toString(), txHash: "0x2" });

    expect(at(BREAD_EURE, state)).toEqual({ done: true, position: null, amountOut: FILLED });
  });

  it("refuses a state that does not match the converter", async () => {
    const state = await freshState(EURE_BREAD);
    state.legs.pop();
    expect(() => at(EURE_BREAD, state)).toThrow(expect.objectContaining({ code: "invalid_state" }));
  });

  it("converterContracts maps each checksummed address to the selectors its legs may call, merged", () => {
    const allowed = converterContracts(BREAD_EURE, 100);
    const [burn, wrap] = breadBurn.contracts(100);
    expect([...allowed.keys()].sort()).toEqual([SELL, SETTLE, burn.address, wrap.address].sort());
    expect(allowed.get(SELL)).toEqual(new Set([APPROVE]));
    expect(allowed.get(SETTLE)).toEqual(new Set([PRESIGN]));
    expect(allowed.get(burn.address)).toEqual(new Set(burn.selectors));
    expect(allowed.get(wrap.address)).toEqual(new Set(wrap.selectors));

    // Two legs naming the same contract (any case) pool their selectors, lowercased.
    const other: Leg = {
      ...breadMint,
      contracts: () => [{ address: SELL.toLowerCase() as `0x${string}`, selectors: ["0xDEADBEEF"] }],
    };
    const merged = converterContracts({ id: "x", legs: [swapLeg(GNOSIS_ASSETS.EURE, GNOSIS_ASSETS.WXDAI), other] }, 100);
    expect(merged.get(SELL)).toEqual(new Set([APPROVE, "0xdeadbeef"]));
  });
});

describe("assertConverter", () => {
  it("accepts the registered shapes: legs that chain around exactly one swap", () => {
    expect(() => assertConverter(EURE_BREAD)).not.toThrow();
    expect(() => assertConverter(BREAD_EURE)).not.toThrow();
  });

  it("rejects two swap legs, legs that do not chain, no legs and no id", () => {
    const swap = (from: Erc20AssetId, to: Erc20AssetId) => swapLeg(from, to);
    expect(() => assertConverter({ id: "two-swaps", legs: [swap(GNOSIS_ASSETS.EURE, GNOSIS_ASSETS.WXDAI), swap(GNOSIS_ASSETS.WXDAI, GNOSIS_ASSETS.EURE)] })).toThrow(/two-swaps.*2 swap legs/);
    expect(() => assertConverter({ id: "broken", legs: [swap(GNOSIS_ASSETS.EURE, GNOSIS_ASSETS.WXDAI), breadBurn] })).toThrow(/broken/);
    expect(() => assertConverter({ id: "empty", legs: [] })).toThrow(/empty/);
    expect(() => assertConverter({ id: "", legs: [swap(GNOSIS_ASSETS.EURE, GNOSIS_ASSETS.WXDAI)] })).toThrow(/no id/);
  });
});
