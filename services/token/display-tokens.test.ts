// SPDX-License-Identifier: AGPL-3.0-or-later
import { getAddress } from "viem";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("@/services/db/prisma", () => ({ prisma: { fundDisplayToken: { findMany } } }));

import { getDisplayTokens } from "./display-tokens";
import { customTokenKey, isCustomTokenKey } from "./extra-tokens";

const USDCE = "0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0";
const GNO = "0x9c58bacc331c9aa871afd802db6379a98e80cedb";

const fund = (over: Partial<Parameters<typeof getDisplayTokens>[0]> = {}) => ({
  id: "fund-1",
  tokenChainId: 100,
  showNativeBalance: true,
  showEureBalance: true,
  ...over,
});

beforeEach(() => {
  findMany.mockReset();
});

describe("getDisplayTokens", () => {
  it("lists the enabled built-ins first, then the fund's custom tokens oldest first", async () => {
    findMany.mockResolvedValue([
      { address: USDCE, symbol: "USDC.e", decimals: 6 },
      { address: GNO, symbol: "GNO", decimals: 18 },
    ]);

    const tokens = await getDisplayTokens(fund());

    expect(tokens.map((t) => t.key)).toEqual([
      "native",
      "eure",
      `custom:${USDCE.toLowerCase()}`,
      `custom:${GNO}`,
    ]);
    expect(tokens[2]).toEqual({
      key: `custom:${USDCE.toLowerCase()}`,
      symbol: "USDC.e",
      decimals: 6,
      address: USDCE,
    });
    expect(tokens[3].address).toBe(getAddress(GNO));
    // Scoped to the fund, in registration order.
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { fundId: "fund-1" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
    );
  });

  it("keeps custom tokens when the built-in toggles are off", async () => {
    findMany.mockResolvedValue([{ address: USDCE, symbol: "USDC.e", decimals: 6 }]);
    const tokens = await getDisplayTokens(
      fund({ id: "fund-2", showNativeBalance: false, showEureBalance: false }),
    );
    expect(tokens.map((t) => t.symbol)).toEqual(["USDC.e"]);
  });

  it("is empty with nothing enabled or registered", async () => {
    findMany.mockResolvedValue([]);
    expect(
      await getDisplayTokens(fund({ id: "fund-3", showNativeBalance: false, showEureBalance: false })),
    ).toEqual([]);
  });
});

describe("custom token keys", () => {
  it("are custom:<lowercased address>", () => {
    expect(customTokenKey(USDCE)).toBe(`custom:${USDCE.toLowerCase()}`);
    expect(isCustomTokenKey(customTokenKey(USDCE))).toBe(true);
    expect(isCustomTokenKey(`custom:${USDCE}`)).toBe(false); // not lowercased
    expect(isCustomTokenKey("custom:0x123")).toBe(false);
    expect(isCustomTokenKey("eure")).toBe(false);
  });
});
