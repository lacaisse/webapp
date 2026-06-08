// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { formatTokenAmount } from "@/services/alchemy/format";
import { listTransfersForAccount } from "@/services/alchemy/transfers";
import {
  getAnnotations,
  type TxAnnotation,
} from "@/services/transaction-annotation/annotate";

// One account's token transfer history, normalised for the UI. `direction` is
// relative to the account: tokens received ("in"), sent ("out"), or a self
// transfer ("self"). `value` is a human decimal string in token units.
// `annotation` carries the fund's label for the tx (e.g. a payout fee sweep).
export type AccountTransfer = {
  uniqueId: string;
  hash: string;
  from: string;
  to: string;
  value: string;
  direction: "in" | "out" | "self";
  timestamp: string | null;
  annotation: TxAnnotation | null;
};

export type AccountTransfersPage = {
  transfers: AccountTransfer[];
  nextCursor: string | null;
};

const PAGE_SIZE = 25;

// Token config subset the loader needs (from the fund row).
type TokenContext = {
  tokenAddress: string | null;
  tokenChainId: number | null;
  tokenDecimals: number | null;
};

// Load one page of an account's transfers via Alchemy and map to AccountTransfer.
// Returns an empty page when the fund has no token configured (nothing on-chain
// to read yet). Throws on RPC failure — callers degrade.
export async function loadAccountTransfers(
  fundId: string,
  token: TokenContext,
  accountAddress: string,
  cursor: string | null,
): Promise<AccountTransfersPage> {
  if (!token.tokenAddress || token.tokenChainId == null) {
    return { transfers: [], nextCursor: null };
  }

  const res = await listTransfersForAccount({
    chainId: token.tokenChainId,
    contractAddress: token.tokenAddress,
    account: accountAddress,
    pageSize: PAGE_SIZE,
    cursor,
  });

  // Fund's labels for the hashes on this page (best-effort; empty on error).
  const annotations = await getAnnotations(
    fundId,
    res.transfers.map((tr) => tr.hash),
  );

  const self = accountAddress.toLowerCase();
  const transfers: AccountTransfer[] = res.transfers.map((tr) => {
    const from = tr.from.toLowerCase();
    const to = tr.to.toLowerCase();
    const direction =
      from === self && to === self ? "self" : from === self ? "out" : "in";
    return {
      uniqueId: tr.uniqueId,
      hash: tr.hash,
      from: tr.from,
      to: tr.to,
      value: formatTokenAmount(tr.rawValue, token.tokenDecimals),
      direction,
      timestamp: tr.blockTimestamp,
      annotation: annotations.get(tr.hash.toLowerCase()) ?? null,
    };
  });

  return { transfers, nextCursor: res.nextPageKey };
}
