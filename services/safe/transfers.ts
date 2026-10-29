// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";
import { isAddress } from "viem";

import { formatTokenAmount } from "@/services/alchemy/format";
import { listTransfersForAccount } from "@/services/alchemy/transfers";
import type {
  AccountTransfer,
  AccountTransfersPage,
} from "@/services/token-account/transfers";
import { getDisplayTokens } from "@/services/token/display-tokens";
import { getAnnotations } from "@/services/transaction-annotation/annotate";

// A Safe's on-chain history, the way a holder reads an account: every move of
// the fund token in or out of the Safe, plus xDAI / EURe when the fund shows
// those balances (Settings → Token). Same row shape and block cursor as a
// named account's history (services/token-account/transfers.ts), so the
// accounts TransfersTable renders it; each row also carries its own symbol,
// since one page mixes assets.

export type SafeTransfer = AccountTransfer & { symbol: string | null };

export type SafeTransfersPage = AccountTransfersPage & {
  transfers: SafeTransfer[];
};

const PAGE_SIZE = 25;

// Fund row subset the loader needs.
export type SafeTransfersFund = {
  tokenChainId: number | null;
  tokenAddress: string | null;
  tokenDecimals: number | null;
  tokenSymbol: string | null;
  showNativeBalance: boolean;
  showEureBalance: boolean;
};

type AssetInfo = { symbol: string | null; decimals: number | null };

/**
 * One page of the Safe's transfers across the fund token and the display
 * tokens the fund opted into (built-ins and custom, getDisplayTokens). The Safe must live on the fund's token chain (callers
 * check `safe.chainId === fund.tokenChainId`); an undeployed Safe (its address
 * is a `pending:` placeholder) or a fund with nothing to read yields an empty
 * page. Throws on RPC failure — callers degrade.
 */
export async function loadSafeTransfers(
  fundId: string,
  fund: SafeTransfersFund,
  safeAddress: string,
  cursor: string | null,
): Promise<SafeTransfersPage> {
  const empty: SafeTransfersPage = { transfers: [], nextCursor: null };
  if (fund.tokenChainId == null || !isAddress(safeAddress, { strict: false })) return empty;

  const extras = await getDisplayTokens({
    id: fundId,
    tokenChainId: fund.tokenChainId,
    showNativeBalance: fund.showNativeBalance,
    showEureBalance: fund.showEureBalance,
  });

  // lowercased contract → symbol / decimals; native under its own entry.
  const byContract = new Map<string, AssetInfo>();
  if (fund.tokenAddress) {
    byContract.set(fund.tokenAddress.toLowerCase(), {
      symbol: fund.tokenSymbol,
      decimals: fund.tokenDecimals,
    });
  }
  let native: AssetInfo | null = null;
  for (const tok of extras) {
    const info = { symbol: tok.symbol, decimals: tok.decimals };
    // The fund token keeps its own entry if a custom token ever duplicates it.
    if (tok.address) {
      const contract = tok.address.toLowerCase();
      if (!byContract.has(contract)) byContract.set(contract, info);
    } else {
      native = info;
    }
  }
  if (byContract.size === 0 && !native) return empty;

  const res = await listTransfersForAccount({
    chainId: fund.tokenChainId,
    contractAddresses: [...byContract.keys()],
    includeNative: native != null,
    account: safeAddress,
    pageSize: PAGE_SIZE,
    cursor,
  });

  const annotations = await getAnnotations(
    fundId,
    res.transfers.map((tr) => tr.hash),
  );

  const self = safeAddress.toLowerCase();
  // Every execTransaction the relayer sends is a zero-value native call to
  // the Safe, which Alchemy reports as an "external" transfer of 0 xDAI. That
  // is plumbing, not money moving, so native rows with no value are dropped.
  const moved = res.transfers.filter(
    (tr) => !(tr.contractAddress == null && isZeroHex(tr.rawValue)),
  );
  const transfers: SafeTransfer[] = moved.map((tr) => {
    const from = tr.from.toLowerCase();
    const to = tr.to.toLowerCase();
    const direction =
      from === self && to === self ? "self" : from === self ? "out" : "in";
    // Known asset first; otherwise whatever Alchemy says it is.
    const known =
      tr.contractAddress == null ? native : byContract.get(tr.contractAddress);
    const symbol = known?.symbol ?? tr.asset;
    const decimals = known?.decimals ?? tr.decimals;
    return {
      uniqueId: tr.uniqueId,
      hash: tr.hash,
      from: tr.from,
      to: tr.to,
      value: formatTokenAmount(tr.rawValue, decimals),
      direction,
      timestamp: tr.blockTimestamp,
      annotation: annotations.get(tr.hash.toLowerCase()) ?? null,
      symbol,
    };
  });

  return { transfers, nextCursor: res.nextPageKey };
}

function isZeroHex(hex: string): boolean {
  try {
    return BigInt(hex) === BigInt(0);
  } catch {
    return false;
  }
}
