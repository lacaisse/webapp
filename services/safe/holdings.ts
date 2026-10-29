// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { getBalances, getNativeBalances } from "@/services/alchemy/balances";
import { getDisplayTokens } from "@/services/token/display-tokens";

import type { TransferFund } from "./proposals";

// Does the Safe hold anything La Caisse shows for this fund — the fund
// token, or one of the display tokens (xDAI / EURe / custom)? Null when a
// balance read failed (the caller decides; archive refuses). A Safe on
// another chain than the fund token holds nothing we can see.

export async function safeHoldsValue(
  fund: TransferFund,
  safe: { chainId: number; address: string },
): Promise<boolean | null> {
  if (safe.chainId !== fund.tokenChainId) return false;
  const addresses = [safe.address.toLowerCase()];
  try {
    const reads: Promise<{ rawBalance: string | bigint }[]>[] = [];
    if (fund.tokenAddress) {
      reads.push(
        getBalances({ chainId: fund.tokenChainId, contractAddress: fund.tokenAddress, addresses }),
      );
    }
    for (const tok of await getDisplayTokens(fund)) {
      reads.push(
        tok.address
          ? getBalances({ chainId: fund.tokenChainId, contractAddress: tok.address, addresses })
          : getNativeBalances({ chainId: fund.tokenChainId, addresses }),
      );
    }
    const rows = (await Promise.all(reads)).flat();
    return rows.some((r) => BigInt(r.rawBalance) > BigInt(0));
  } catch (e) {
    console.warn("[safe] holdings read failed", safe.address, e instanceof Error ? e.message : e);
    return null;
  }
}
