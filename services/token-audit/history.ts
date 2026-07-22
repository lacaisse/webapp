// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import {
  listTransfersForAccount,
  type AlchemyTransfer,
} from "@/services/alchemy/transfers";

import { sortNewestFirst } from "./timeline";

// Load an account's *entire* transfer history for the fund's token by walking
// Alchemy's cursor until it runs dry. The audit view needs the full history —
// a running balance is only trustworthy when every transfer between "now" and
// a given row is present. Bounded by MAX_PAGES as a runaway guard for
// pathologically active wallets; `complete: false` tells the UI to say the
// window is partial instead of claiming a reconciliation it can't prove.

const FETCH_PAGE_SIZE = 100;
const MAX_PAGES = 10; // ≥ 1000 transfers per direction — far beyond any fund wallet today

export type AccountHistory = {
  /** Newest first, deduped, globally ordered (block desc, log index desc). */
  transfers: AlchemyTransfer[];
  /** True when Alchemy's cursor was exhausted — the history is the whole story. */
  complete: boolean;
};

export async function loadFullAccountHistory(opts: {
  chainId: number;
  contractAddress: string;
  account: string;
}): Promise<AccountHistory> {
  // Dedupe on uniqueId: the merged from/to streams both return self-transfers,
  // and stream pages can overlap at cursor boundaries.
  const byId = new Map<string, AlchemyTransfer>();
  let cursor: string | null = null;
  let complete = false;

  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await listTransfersForAccount({
      chainId: opts.chainId,
      contractAddress: opts.contractAddress,
      account: opts.account,
      pageSize: FETCH_PAGE_SIZE,
      cursor,
    });
    for (const transfer of res.transfers) byId.set(transfer.uniqueId, transfer);
    cursor = res.nextPageKey;
    if (!cursor) {
      complete = true;
      break;
    }
  }

  return { transfers: sortNewestFirst([...byId.values()]), complete };
}
