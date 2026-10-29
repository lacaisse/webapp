// SPDX-License-Identifier: AGPL-3.0-or-later
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/services/alchemy/transfers", () => ({
  listTransfersForAccount: vi.fn(),
}));
vi.mock("@/services/transaction-annotation/annotate", () => ({
  getAnnotations: vi.fn(async () => new Map()),
}));
// The real built-in registry plus the fund's custom tokens (set per test).
const custom = vi.hoisted(() => ({
  tokens: [] as { key: `custom:${string}`; symbol: string; decimals: number; address: `0x${string}` }[],
}));
vi.mock("@/services/token/display-tokens", async () => {
  const { enabledExtraTokens } = await import("@/services/token/extra-tokens");
  return {
    getDisplayTokens: vi.fn(async (fund: Parameters<typeof enabledExtraTokens>[0]) => [
      ...enabledExtraTokens(fund),
      ...custom.tokens,
    ]),
  };
});

import {
  listTransfersForAccount,
  type AlchemyTransfer,
} from "@/services/alchemy/transfers";

import { loadSafeTransfers, type SafeTransfersFund } from "./transfers";

const list = vi.mocked(listTransfersForAccount);

const SAFE = "0x1bfa424F82B7e6139b80D96D04C1eaD93Ac5B07d";
const OTHER = "0x2222222222222222222222222222222222222222";
const TOKEN = "0x5815E61eF72c9E6107b5c5A05FD121F334f7a7f1";
const EURE = "0x420ca0f9b9b604ce0fd9c18ef134c705e5fa3430";

const FUND: SafeTransfersFund = {
  tokenChainId: 100,
  tokenAddress: TOKEN,
  tokenDecimals: 6,
  tokenSymbol: "CAI",
  showNativeBalance: true,
  showEureBalance: true,
};

function tr(over: Partial<AlchemyTransfer>): AlchemyTransfer {
  return {
    uniqueId: "u",
    blockNum: "0x1",
    hash: "0xh",
    from: OTHER,
    to: SAFE,
    rawValue: "0x0",
    value: null,
    blockTimestamp: null,
    contractAddress: null,
    asset: null,
    decimals: null,
    ...over,
  };
}

beforeEach(() => {
  list.mockReset();
  custom.tokens = [];
});

describe("loadSafeTransfers", () => {
  it("asks for the fund token, EURe and xDAI when both toggles are on", async () => {
    list.mockResolvedValue({ transfers: [], nextPageKey: null });
    await loadSafeTransfers("fund", FUND, SAFE, "cur");
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        chainId: 100,
        contractAddresses: [TOKEN.toLowerCase(), EURE],
        includeNative: true,
        account: SAFE,
        cursor: "cur",
      }),
    );
  });

  it("asks for the fund token alone when the toggles are off", async () => {
    list.mockResolvedValue({ transfers: [], nextPageKey: null });
    await loadSafeTransfers(
      "fund",
      { ...FUND, showNativeBalance: false, showEureBalance: false },
      SAFE,
      null,
    );
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        contractAddresses: [TOKEN.toLowerCase()],
        includeNative: false,
      }),
    );
  });

  it("maps each row to its symbol and decimals", async () => {
    list.mockResolvedValue({
      transfers: [
        tr({
          uniqueId: "a",
          contractAddress: TOKEN.toLowerCase(),
          rawValue: "0x1e8480", // 2_000_000 at 6 decimals
          from: SAFE,
          to: OTHER,
        }),
        tr({
          uniqueId: "b",
          contractAddress: EURE,
          asset: "EURe",
          decimals: 18,
          rawValue: "0x14d1120d7b160000", // 1.5e18
        }),
        tr({
          uniqueId: "c",
          contractAddress: null,
          asset: "XDAI",
          rawValue: "0x16345785d8a0000", // 0.1e18
          from: SAFE,
          to: SAFE,
        }),
      ],
      nextPageKey: "next",
    });
    const page = await loadSafeTransfers("fund", FUND, SAFE, null);
    expect(page.nextCursor).toBe("next");
    expect(
      page.transfers.map((t) => [t.uniqueId, t.direction, t.value, t.symbol]),
    ).toEqual([
      ["a", "out", "2", "CAI"],
      ["b", "in", "1.5", "EURe"],
      ["c", "self", "0.1", "xDAI"],
    ]);
  });

  it("drops zero-value native rows (the relayer's execTransaction calls)", async () => {
    list.mockResolvedValue({
      transfers: [
        tr({ uniqueId: "exec", contractAddress: null, asset: "XDAI", rawValue: "0x0" }),
        tr({ uniqueId: "gas", contractAddress: null, asset: "XDAI", rawValue: "0x2386f26fc10000" }), // 0.01
        tr({ uniqueId: "zero-token", contractAddress: TOKEN.toLowerCase(), rawValue: "0x0" }),
      ],
      nextPageKey: null,
    });
    const page = await loadSafeTransfers("fund", FUND, SAFE, null);
    expect(page.transfers.map((t) => t.uniqueId)).toEqual(["gas", "zero-token"]);
  });

  it("falls back to Alchemy's asset and decimals for an unknown contract", async () => {
    list.mockResolvedValue({
      transfers: [
        tr({
          contractAddress: "0xdead",
          asset: "FOO",
          decimals: 2,
          rawValue: "0x7b", // 123
        }),
      ],
      nextPageKey: null,
    });
    const [row] = (await loadSafeTransfers("fund", FUND, SAFE, null)).transfers;
    expect([row!.value, row!.symbol]).toEqual(["1.23", "FOO"]);
  });

  it("includes the fund's custom tokens and labels their rows", async () => {
    const USDCE = "0x2a22f9c3b484c3629090FeED35F17Ff8F88f76F0" as const;
    custom.tokens = [
      { key: `custom:${USDCE.toLowerCase()}`, symbol: "USDC.e", decimals: 6, address: USDCE },
    ];
    list.mockResolvedValue({
      transfers: [
        tr({ uniqueId: "u", contractAddress: USDCE.toLowerCase(), rawValue: "0x2625a0" }), // 2.5 at 6
      ],
      nextPageKey: null,
    });

    const page = await loadSafeTransfers(
      "fund",
      { ...FUND, showNativeBalance: false, showEureBalance: false },
      SAFE,
      null,
    );

    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        contractAddresses: [TOKEN.toLowerCase(), USDCE.toLowerCase()],
        includeNative: false,
      }),
    );
    expect(page.transfers.map((t) => [t.value, t.symbol])).toEqual([["2.5", "USDC.e"]]);
  });

  it("returns an empty page for an undeployed Safe", async () => {
    const page = await loadSafeTransfers("fund", FUND, "pending:42", null);
    expect(page).toEqual({ transfers: [], nextCursor: null });
    expect(list).not.toHaveBeenCalled();
  });
});
