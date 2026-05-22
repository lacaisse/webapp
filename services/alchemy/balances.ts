// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";
import { cache } from "react";
import { alchemyNetwork, alchemyRpc } from "./client";

// `alchemy_getTokenBalances` queries one wallet's balance across a list of
// token contracts. There's no inverse "who holds this token?" endpoint in
// Alchemy's Token API — for a community-currency dashboard we don't need
// it anyway: the universe of wallets we care about is the cards we issued
// (plus the treasury minter and connected merchant places). So we fan out
// one RPC call per address and merge.
//
// `getBalance` is wrapped in React's `cache()` so the same (chain, token,
// wallet) tuple resolves to a single fetch per request — duplicate
// addresses across cards / places / minter don't trigger redundant work,
// and other server components in the same render can share results.

type RpcBalanceResponse = {
  address: string;
  tokenBalances: Array<{
    contractAddress: string;
    tokenBalance: string | null;
    error?: string | null;
  }>;
};

const CONCURRENCY = 10;

export type WalletBalance = {
  address: string; // lowercased
  rawBalance: string; // hex, "0x0" if missing
};

/**
 * Per-address balance lookup, memoised for the lifetime of a single React
 * render via `cache()`. Args are normalised (lowercased) at the call site
 * so the cache key is stable.
 */
const getBalance = cache(
  async (
    network: string,
    contract: string,
    address: string,
  ): Promise<string> => {
    const result = await alchemyRpc<RpcBalanceResponse>(
      network,
      "alchemy_getTokenBalances",
      [address, [contract]],
    );
    const entry = result.tokenBalances.find(
      (b) => b.contractAddress.toLowerCase() === contract,
    );
    return entry?.tokenBalance ?? "0x0";
  },
);

export async function getBalances(opts: {
  chainId: number;
  contractAddress: string;
  addresses: string[];
}): Promise<WalletBalance[]> {
  const network = alchemyNetwork(opts.chainId);
  if (!network) {
    throw new Error(`Alchemy: unsupported chain id ${opts.chainId}`);
  }
  if (opts.addresses.length === 0) return [];

  const contract = opts.contractAddress.toLowerCase();
  const normalised = opts.addresses.map((a) => a.toLowerCase());
  // Dedupe: same address in cards + places + minter should hit Alchemy
  // once. The cache layer guarantees this too, but explicit dedup also
  // keeps the concurrency runner from spawning redundant workers.
  const unique = [...new Set(normalised)];

  const balanceByAddress = new Map<string, string>();
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(CONCURRENCY, unique.length) },
    async () => {
      while (true) {
        const i = cursor++;
        if (i >= unique.length) return;
        const addr = unique[i]!;
        balanceByAddress.set(addr, await getBalance(network, contract, addr));
      }
    },
  );
  await Promise.all(workers);

  // Return one row per input address (preserving input order). Duplicates
  // in the input map to the same balance — they share the cache hit.
  return normalised.map((addr) => ({
    address: addr,
    rawBalance: balanceByAddress.get(addr) ?? "0x0",
  }));
}
