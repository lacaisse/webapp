// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { getBundlerTxReceipt } from "@/services/token/userop";

// Resolve the settlement status of payout-order hashes for the detail view,
// via the CitizenPay bundler URL (a full JSON-RPC node) using
// `eth_getTransactionReceipt`. "pending" means no receipt yet (not mined /
// unknown to the node); the UI treats that as unconfirmed.
//
// To stay under the bundler's rate limits we resolve in small sequential
// batches with a short pause between them rather than firing every hash at
// once.

export type TxReceiptStatus = "success" | "reverted" | "pending";

export type TxReceipt = {
  txHash: string;
  status: TxReceiptStatus;
  blockNumber: number | null;
};

const BATCH_SIZE = 5;
const BATCH_PAUSE_MS = 150;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function resolveOne(chainId: number, hash: string): Promise<TxReceipt> {
  const receipt = await getBundlerTxReceipt({ chainId, txHash: hash });
  if (receipt) {
    return { txHash: hash, status: receipt.status, blockNumber: receipt.blockNumber };
  }
  // No receipt yet (not mined / unknown to the node) → unconfirmed.
  return { txHash: hash, status: "pending", blockNumber: null };
}

export async function resolveOrderReceipts(args: {
  chainId: number;
  hashes: string[];
}): Promise<Map<string, TxReceipt>> {
  const out = new Map<string, TxReceipt>();
  const unique = [...new Set(args.hashes.filter(Boolean))];
  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const batch = unique.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map((hash) => resolveOne(args.chainId, hash)),
    );
    results.forEach((r) => out.set(r.txHash, r));
    if (i + BATCH_SIZE < unique.length) await sleep(BATCH_PAUSE_MS);
  }
  return out;
}
