// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { normaliseTreasury } from "./sync";

describe("normaliseTreasury — chain", () => {
  it("takes the numeric chain_id first", () => {
    expect(normaliseTreasury({ chain: "Gnosis", chain_id: 100 }).tokenChainId).toBe(100);
    expect(normaliseTreasury({ chain: "polygon", chain_id: 100 }).tokenChainId).toBe(100);
    expect(
      normaliseTreasury({ token: { chain: "gnosis", chain_id: 137 } }).tokenChainId,
    ).toBe(137);
  });

  it("ignores a non-positive or non-integer chain_id", () => {
    expect(normaliseTreasury({ chain: "gnosis", chain_id: 0 }).tokenChainId).toBe(100);
    expect(normaliseTreasury({ chain: "gnosis", chain_id: 1.5 }).tokenChainId).toBe(100);
  });

  it("falls back to a numeric chain prefix (Flow 1 treasuries carry \"100\")", () => {
    expect(normaliseTreasury({ chain: "100" }).tokenChainId).toBe(100);
  });

  it("falls back to the name map (older treasuries carry \"Gnosis\")", () => {
    expect(normaliseTreasury({ chain: "Gnosis" }).tokenChainId).toBe(100);
    expect(normaliseTreasury({ chain: "base" }).tokenChainId).toBe(8453);
  });

  it("leaves the chain null when nothing is recognised", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(normaliseTreasury({ chain: "vchain" }).tokenChainId).toBeNull();
    expect(normaliseTreasury({}).tokenChainId).toBeNull();
    warn.mockRestore();
  });
});
