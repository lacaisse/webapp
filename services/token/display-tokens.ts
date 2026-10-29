// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";
import { cache } from "react";
import { getAddress } from "viem";

import { prisma } from "@/services/db/prisma";

import {
  customTokenKey,
  enabledExtraTokens,
  type BalanceDisplaySettings,
  type ExtraToken,
} from "./extra-tokens";

// Every balance a fund shows next to its fund token on the Accounts pages:
// the built-in extra tokens it toggled on (xDAI / EURe, registry order), then
// the custom ERC-20s it registered (FundDisplayToken, oldest first). One list
// feeds the balance lines, the Safe history and the Safe transfer picker.

export type DisplayTokensFund = BalanceDisplaySettings & { id: string };

// Cached on primitives so callers passing different fund objects (the host
// fund, a `display` subset) still share one query per request.
const loadDisplayTokens = cache(
  async (
    fundId: string,
    tokenChainId: number,
    showNativeBalance: boolean,
    showEureBalance: boolean,
  ): Promise<ExtraToken[]> => {
    const builtIns = enabledExtraTokens({ tokenChainId, showNativeBalance, showEureBalance });
    const rows = await prisma.fundDisplayToken.findMany({
      where: { fundId },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { address: true, symbol: true, decimals: true },
    });
    return [
      ...builtIns,
      ...rows.map(
        (r): ExtraToken => ({
          key: customTokenKey(r.address),
          symbol: r.symbol,
          decimals: r.decimals,
          address: getAddress(r.address),
        }),
      ),
    ];
  },
);

/** The fund's display tokens: enabled built-ins first, then its custom tokens. */
export function getDisplayTokens(fund: DisplayTokensFund): Promise<ExtraToken[]> {
  return loadDisplayTokens(
    fund.id,
    fund.tokenChainId,
    fund.showNativeBalance,
    fund.showEureBalance,
  );
}

export type CustomDisplayToken = {
  id: string;
  address: string; // checksummed
  symbol: string;
  name: string;
  decimals: number;
};

/** The fund's registered custom tokens, oldest first (Settings → Token). */
export async function listCustomDisplayTokens(fundId: string): Promise<CustomDisplayToken[]> {
  return prisma.fundDisplayToken.findMany({
    where: { fundId },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true, address: true, symbol: true, name: true, decimals: true },
  });
}
