// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";
import { cache } from "react";

import { getBalances, getNativeBalances } from "@/services/alchemy/balances";
import {
  enabledExtraTokens,
  formatExtraAmount,
  type BalanceDisplaySettings,
  type ExtraTokenKey,
} from "@/services/token/extra-tokens";

import { isDeployedAddress } from "./safes/format";

// Balances besides the fund token (xDAI, EURe) that a fund opted to show on
// the Accounts pages (Fund.showNativeBalance / showEureBalance). One call per
// page with every address on it; a chain hiccup degrades to `error: true` and
// an empty map — the page shows "—" for those lines, never fails.

export type ExtraBalance = {
  key: ExtraTokenKey;
  symbol: string;
  amount: string; // human units, truncated to 4 decimals
};

export type ExtraBalances = {
  byAddress: Map<string, ExtraBalance[]>; // key: lowercased address
  error: boolean;
};

export const getExtraBalances = cache(
  async (
    fund: BalanceDisplaySettings,
    addresses: string[],
  ): Promise<ExtraBalances> => {
    const tokens = enabledExtraTokens(fund);
    // Undeployed Safes carry a `pending:<nonce>` placeholder, not an address.
    const real = [
      ...new Set(addresses.filter(isDeployedAddress).map((a) => a.toLowerCase())),
    ];
    if (tokens.length === 0 || real.length === 0) {
      return { byAddress: new Map(), error: false };
    }

    try {
      const perToken = await Promise.all(
        tokens.map(async (tok) => {
          const rows = tok.address
            ? await getBalances({
                chainId: fund.tokenChainId,
                contractAddress: tok.address,
                addresses: real,
              })
            : await getNativeBalances({ chainId: fund.tokenChainId, addresses: real });
          return { tok, raw: new Map(rows.map((r) => [r.address, r.rawBalance])) };
        }),
      );

      const byAddress = new Map<string, ExtraBalance[]>();
      for (const addr of real) {
        byAddress.set(
          addr,
          perToken.map(({ tok, raw }) => ({
            key: tok.key,
            symbol: tok.symbol,
            amount: formatExtraAmount(raw.get(addr) ?? "0x0", tok.decimals),
          })),
        );
      }
      return { byAddress, error: false };
    } catch (e) {
      console.warn("[accounts] extra balances failed", e);
      return { byAddress: new Map(), error: true };
    }
  },
);
