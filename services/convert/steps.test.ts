// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { conversionProgress } from "./steps";
import type { ConversionState } from "./types";

const SWAP = { id: "cow-swap", exact: false, steps: ["api", "calls", "wait"] as const };
const MINT = { id: "bread-mint", exact: true, steps: ["calls"] as const };
const BURN = { id: "bread-burn", exact: true, steps: ["calls"] as const };
const Q = { amountIn: "1", amountOut: "1", minAmountOut: "1", validUntil: "2026-11-10T00:00:00Z" };

function state(...results: ConversionState["legs"][number]["results"][]): ConversionState {
  return { legs: results.map((r) => ({ quote: Q, results: r })) };
}

describe("conversionProgress", () => {
  it("EURe → BREAD: order, swap transaction, fill, mint transaction", () => {
    expect(conversionProgress([SWAP, MINT], state([], [])).map((s) => [s.key, s.state])).toEqual([
      ["cow-swap.api", "active"],
      ["cow-swap.calls", "pending"],
      ["cow-swap.wait", "pending"],
      ["bread-mint.calls", "pending"],
    ]);
    const filling = state([{ kind: "api", ref: "0xuid" }, { kind: "calls", txHash: "0x1" }], []);
    expect(conversionProgress([SWAP, MINT], filling)).toEqual([
      { key: "cow-swap.api", state: "done", txHash: null },
      { key: "cow-swap.calls", state: "done", txHash: "0x1" },
      { key: "cow-swap.wait", state: "active", txHash: null },
      { key: "bread-mint.calls", state: "pending", txHash: null },
    ]);
    const done = state(
      [{ kind: "api", ref: "0xuid" }, { kind: "calls", txHash: "0x1" }, { kind: "wait", amountOut: "9", txHash: "0x2" }],
      [{ kind: "calls", txHash: "0x3" }],
    );
    expect(conversionProgress([SWAP, MINT], done).map((s) => [s.state, s.txHash])).toEqual([
      ["done", null],
      ["done", "0x1"],
      ["done", "0x2"],
      ["done", "0x3"],
    ]);
  });

  it("BREAD → EURe: the burn folds into the swap's transaction — three lines, not four", () => {
    expect(conversionProgress([BURN, SWAP], state([], [])).map((s) => s.key)).toEqual([
      "cow-swap.api",
      "bread-burn+cow-swap.calls",
      "cow-swap.wait",
    ]);
    const afterBatch = state([{ kind: "calls", txHash: "0x1" }], [{ kind: "api", ref: "0xuid" }, { kind: "calls", txHash: "0x1" }]);
    expect(conversionProgress([BURN, SWAP], afterBatch).map((s) => [s.key, s.state, s.txHash])).toEqual([
      ["cow-swap.api", "done", null],
      ["bread-burn+cow-swap.calls", "done", "0x1"],
      ["cow-swap.wait", "active", null],
    ]);
  });

  it("a finished conversion shows every step done", () => {
    expect(conversionProgress([SWAP, MINT], state([], []), true).every((s) => s.state === "done")).toBe(true);
  });
});
