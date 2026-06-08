// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";
import { cache } from "react";

import { getBalances } from "@/services/alchemy/balances";
import { formatTokenAmount } from "@/services/alchemy/format";
import { prisma } from "@/services/db/prisma";
import {
  loadAccountTransfers,
  type AccountTransfersPage,
} from "@/services/token-account/transfers";

// Loaders for the Accounts views. cache()-wrapped so repeat reads in one render
// share a single round-trip; balance reads degrade to null on RPC error so a
// chain hiccup shows "—" rather than breaking the page.

export type TokenAccountRow = {
  id: string;
  name: string;
  saltNonce: number;
  address: string;
  balance: string | null; // human token units, or null when unavailable
  createdAt: string;
};

type TokenContext = {
  tokenAddress: string | null;
  tokenChainId: number | null;
  tokenDecimals: number | null;
};

export const getTokenAccounts = cache(
  async (
    fundId: string,
    token: TokenContext,
  ): Promise<{ accounts: TokenAccountRow[]; balancesError: boolean }> => {
    const rows = await prisma.fundTokenAccount.findMany({
      where: { fundId, archivedAt: null },
      orderBy: { createdAt: "asc" },
    });

    const base = rows.map((r) => ({
      id: r.id,
      name: r.name,
      saltNonce: r.saltNonce,
      address: r.address,
      createdAt: r.createdAt.toISOString(),
    }));

    if (rows.length === 0 || !token.tokenAddress || token.tokenChainId == null) {
      return {
        accounts: base.map((r) => ({ ...r, balance: null })),
        balancesError: false,
      };
    }

    let byAddress = new Map<string, string>();
    let balancesError = false;
    try {
      const balances = await getBalances({
        chainId: token.tokenChainId,
        contractAddress: token.tokenAddress,
        addresses: rows.map((r) => r.address),
      });
      byAddress = new Map(
        balances.map((b) => [
          b.address.toLowerCase(),
          formatTokenAmount(b.rawBalance, token.tokenDecimals),
        ]),
      );
    } catch (e) {
      console.warn("[accounts] getBalances failed", e);
      balancesError = true;
    }

    return {
      accounts: base.map((r) => ({
        ...r,
        balance: byAddress.get(r.address.toLowerCase()) ?? null,
      })),
      balancesError,
    };
  },
);

export const getTokenAccount = cache(
  async (fundId: string, id: string) => {
    return prisma.fundTokenAccount.findFirst({
      where: { id, fundId, archivedAt: null },
    });
  },
);

// Other active accounts in the fund (for the transfer destination picker).
export const getAccountOptions = cache(
  async (
    fundId: string,
    excludeId: string,
  ): Promise<{ id: string; name: string; address: string }[]> => {
    return prisma.fundTokenAccount.findMany({
      where: { fundId, archivedAt: null, id: { not: excludeId } },
      orderBy: { createdAt: "asc" },
      select: { id: true, name: true, address: true },
    });
  },
);

export const getAccountBalance = cache(
  async (address: string, token: TokenContext): Promise<string | null> => {
    if (!token.tokenAddress || token.tokenChainId == null) return null;
    try {
      const [bal] = await getBalances({
        chainId: token.tokenChainId,
        contractAddress: token.tokenAddress,
        addresses: [address],
      });
      if (!bal) return null;
      return formatTokenAmount(bal.rawBalance, token.tokenDecimals);
    } catch (e) {
      console.warn("[accounts] getAccountBalance failed", e);
      return null;
    }
  },
);

// First page of transfer history for the detail view. Degrades to an empty
// page with an error flag so the page renders without the history.
export const getAccountTransfersFirstPage = cache(
  async (
    fundId: string,
    token: TokenContext,
    address: string,
  ): Promise<AccountTransfersPage & { error: boolean }> => {
    try {
      const page = await loadAccountTransfers(fundId, token, address, null);
      return { ...page, error: false };
    } catch (e) {
      console.warn("[accounts] first transfers page failed", e);
      return { transfers: [], nextCursor: null, error: true };
    }
  },
);
