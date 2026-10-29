// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { enabledExtraTokens, formatExtraAmount } from "./extra-tokens";

const keys = (fund: Parameters<typeof enabledExtraTokens>[0]) =>
  enabledExtraTokens(fund).map((t) => t.key);

describe("enabledExtraTokens", () => {
  it("shows nothing by default", () => {
    expect(
      keys({ tokenChainId: 100, showNativeBalance: false, showEureBalance: false }),
    ).toEqual([]);
  });

  it("returns the enabled Gnosis tokens in registry order", () => {
    expect(
      keys({ tokenChainId: 100, showNativeBalance: true, showEureBalance: false }),
    ).toEqual(["native"]);
    expect(
      keys({ tokenChainId: 100, showNativeBalance: false, showEureBalance: true }),
    ).toEqual(["eure"]);
    const both = enabledExtraTokens({
      tokenChainId: 100,
      showNativeBalance: true,
      showEureBalance: true,
    });
    expect(both.map((t) => [t.key, t.symbol, t.decimals, t.address])).toEqual([
      ["native", "xDAI", 18, null],
      ["eure", "EURe", 18, "0x420CA0f9B9b604cE0fd9C18EF134C705e5Fa3430"],
    ]);
  });

  it("has nothing for a chain without a registry entry", () => {
    expect(
      keys({ tokenChainId: 8453, showNativeBalance: true, showEureBalance: true }),
    ).toEqual([]);
  });
});

describe("formatExtraAmount", () => {
  it("truncates 18-decimal amounts to 4 decimals", () => {
    // 12.345678… xDAI
    expect(formatExtraAmount("12345678900000000000", 18)).toBe("12.3456");
    expect(formatExtraAmount("0x3e73362871420000", 18)).toBe("4.5"); // 4.5e18
    expect(formatExtraAmount("0x0", 18)).toBe("0");
    expect(formatExtraAmount("1000000000000", 18)).toBe("0"); // dust
    expect(formatExtraAmount("7000000000000000000", 18)).toBe("7");
  });
});
