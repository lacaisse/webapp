// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

// Thin wrapper around Alchemy's JSON-RPC. Per the project convention every
// external service has its own module — `transfers.ts` and `balances.ts`
// build on top.
//
// Only JSON-RPC is wired today: getAssetTransfers (history) and
// getTokenBalances (per-wallet lookup) both live at the chain endpoint.

// Map our `Fund.tokenChainId` to the network slug Alchemy uses in URLs and
// request bodies. Returning null for unknown chains lets callers decide
// whether to surface "explorer not supported on this chain" vs. throwing.
const ALCHEMY_NETWORK: Record<number, string> = {
  1: "eth-mainnet",
  10: "opt-mainnet",
  100: "gnosis-mainnet",
  137: "polygon-mainnet",
  8453: "base-mainnet",
  42161: "arb-mainnet",
};

export function alchemyNetwork(chainId: number): string | null {
  return ALCHEMY_NETWORK[chainId] ?? null;
}

function requireApiKey(): string {
  const key = process.env.ALCHEMY_API_KEY;
  if (!key) {
    throw new Error(
      "ALCHEMY_API_KEY is not set — token explorer requires Alchemy access.",
    );
  }
  return key;
}

/**
 * JSON-RPC POST to the chain-specific Alchemy endpoint. Used for
 * `alchemy_getAssetTransfers` and any other `eth_*` / `alchemy_*` method.
 *
 * Throws on transport error, non-2xx, or a JSON-RPC `error` field. The
 * caller is responsible for narrowing the `result` shape.
 */
export async function alchemyRpc<T>(
  network: string,
  method: string,
  params: unknown[],
): Promise<T> {
  const url = `https://${network}.g.alchemy.com/v2/${requireApiKey()}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: 1, jsonrpc: "2.0", method, params }),
    // Alchemy responses are point-in-time; we cache via the page itself so
    // requests should not be cached at the fetch layer.
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Alchemy ${method} HTTP ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) {
    throw new Error(`Alchemy ${method} error: ${body.error.message}`);
  }
  if (body.result === undefined) {
    throw new Error(`Alchemy ${method} returned no result`);
  }
  return body.result;
}

