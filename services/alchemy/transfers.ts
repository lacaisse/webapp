// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";
import { alchemyNetwork, alchemyRpc } from "./client";

// `alchemy_getAssetTransfers` — paginated ERC-20 transfer history. We
// request `desc` order so the newest transfers come first; the opaque
// `pageKey` walks backwards through history.
//
// Alchemy returns `value` already divided by the token's decimals (as a
// JS number). For currency-style display we want exact strings, so we
// also surface `rawValue` (a hex bigint) and let the UI format using the
// decimals we already cached on Fund.
//
// Timestamp quirk: `withMetadata: true` only enriches the response on
// ETH / Base / Polygon / Arbitrum / Optimism (per Alchemy docs). On
// Gnosis the `metadata.blockTimestamp` field is missing, so we fall back
// to `eth_getBlockByNumber` per unique block to recover the time.

export type AlchemyTransfer = {
  uniqueId: string;
  blockNum: string;
  hash: string;
  from: string;
  to: string;
  rawValue: string; // hex string, before decimals
  // Decimal amount Alchemy computed using the token's own on-chain decimals —
  // independent of any cached decimals we hold. Null when Alchemy can't resolve
  // it. Prefer this over formatting rawValue with a (possibly stale) decimals.
  value: number | null;
  blockTimestamp: string | null; // ISO from metadata, optional
};

type RpcTransferResponse = {
  transfers: Array<{
    uniqueId: string;
    blockNum: string;
    hash: string;
    from: string;
    to: string;
    value?: number | null;
    rawContract?: { value?: string };
    metadata?: { blockTimestamp?: string };
  }>;
  pageKey?: string;
};

export type ListTransfersResult = {
  transfers: AlchemyTransfer[];
  nextPageKey: string | null;
};

export async function listTransfers(opts: {
  chainId: number;
  contractAddress: string;
  pageSize: number;
  pageKey?: string | null;
}): Promise<ListTransfersResult> {
  const network = alchemyNetwork(opts.chainId);
  if (!network) {
    throw new Error(`Alchemy: unsupported chain id ${opts.chainId}`);
  }

  const { transfers, pageKey } = await fetchTransfersPage(network, {
    contractAddress: opts.contractAddress,
    pageSize: opts.pageSize,
    pageKey: opts.pageKey,
  });

  await hydrateMissingTimestamps(network, transfers);

  return { transfers, nextPageKey: pageKey ?? null };
}

// `alchemy_getAssetTransfers` filters by `fromAddress` OR `toAddress`, never
// the disjunction. To show all transfers involving a single wallet we run
// the two queries in parallel and merge. Pagination piggy-backs on each
// stream's own pageKey: the cursor we surface to callers encodes both keys
// so each "page" advances both streams together — the merge stays in block-
// desc order across pages because each stream is independently desc-sorted.
// When a stream runs out, we stop querying it; once both are exhausted, the
// next cursor is null.

type AccountCursor = { f?: string | null; t?: string | null };

function encodeAccountCursor(c: AccountCursor): string | null {
  const f = c.f ?? null;
  const t = c.t ?? null;
  if (f == null && t == null) return null;
  return Buffer.from(JSON.stringify({ f, t })).toString("base64url");
}

function decodeAccountCursor(s: string | null): AccountCursor | null {
  if (!s) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(s, "base64url").toString("utf8"),
    ) as AccountCursor;
    return parsed;
  } catch {
    return null;
  }
}

export async function listTransfersForAccount(opts: {
  chainId: number;
  contractAddress: string;
  account: string;
  pageSize: number;
  cursor?: string | null;
}): Promise<ListTransfersResult> {
  const network = alchemyNetwork(opts.chainId);
  if (!network) {
    throw new Error(`Alchemy: unsupported chain id ${opts.chainId}`);
  }

  const decoded = decodeAccountCursor(opts.cursor ?? null);
  // First page: query both directions. Subsequent pages: only query a
  // direction if its pageKey from the previous page is non-null.
  const queryFrom = decoded == null || decoded.f != null;
  const queryTo = decoded == null || decoded.t != null;

  const empty: { transfers: AlchemyTransfer[]; pageKey?: string } = {
    transfers: [],
  };
  const [fromPage, toPage] = await Promise.all([
    queryFrom
      ? fetchTransfersPage(network, {
          contractAddress: opts.contractAddress,
          pageSize: opts.pageSize,
          pageKey: decoded?.f ?? null,
          fromAddress: opts.account,
        })
      : Promise.resolve(empty),
    queryTo
      ? fetchTransfersPage(network, {
          contractAddress: opts.contractAddress,
          pageSize: opts.pageSize,
          pageKey: decoded?.t ?? null,
          toAddress: opts.account,
        })
      : Promise.resolve(empty),
  ]);

  // Dedupe self-transfers (same uniqueId from both queries) and sort by
  // block number descending. blockNum is a hex string — compare as bigint.
  const byId = new Map<string, AlchemyTransfer>();
  for (const t of fromPage.transfers) byId.set(t.uniqueId, t);
  for (const t of toPage.transfers) byId.set(t.uniqueId, t);
  const transfers = [...byId.values()].sort((a, b) => {
    const av = BigInt(a.blockNum || "0x0");
    const bv = BigInt(b.blockNum || "0x0");
    if (bv > av) return 1;
    if (bv < av) return -1;
    return 0;
  });

  await hydrateMissingTimestamps(network, transfers);

  const nextPageKey = encodeAccountCursor({
    f: fromPage.pageKey ?? null,
    t: toPage.pageKey ?? null,
  });

  return { transfers, nextPageKey };
}

async function fetchTransfersPage(
  network: string,
  opts: {
    contractAddress: string;
    pageSize: number;
    pageKey?: string | null;
    fromAddress?: string;
    toAddress?: string;
  },
): Promise<{ transfers: AlchemyTransfer[]; pageKey?: string }> {
  const params: Record<string, unknown> = {
    fromBlock: "0x0",
    toBlock: "latest",
    contractAddresses: [opts.contractAddress],
    category: ["erc20"],
    order: "desc",
    withMetadata: true,
    excludeZeroValue: false,
    maxCount: "0x" + Math.min(Math.max(opts.pageSize, 1), 1000).toString(16),
  };
  if (opts.pageKey) params.pageKey = opts.pageKey;
  if (opts.fromAddress) params.fromAddress = opts.fromAddress;
  if (opts.toAddress) params.toAddress = opts.toAddress;

  const result = await alchemyRpc<RpcTransferResponse>(
    network,
    "alchemy_getAssetTransfers",
    [params],
  );

  const transfers: AlchemyTransfer[] = result.transfers.map((t) => ({
    uniqueId: t.uniqueId,
    blockNum: t.blockNum,
    hash: t.hash,
    from: t.from,
    to: t.to,
    rawValue: t.rawContract?.value ?? "0x0",
    value: typeof t.value === "number" ? t.value : null,
    blockTimestamp: t.metadata?.blockTimestamp ?? null,
  }));

  return { transfers, pageKey: result.pageKey };
}

const BLOCK_FETCH_CONCURRENCY = 10;

async function hydrateMissingTimestamps(
  network: string,
  transfers: AlchemyTransfer[],
): Promise<void> {
  const missingBlocks = new Set<string>();
  for (const t of transfers) {
    if (!t.blockTimestamp && t.blockNum) missingBlocks.add(t.blockNum);
  }
  if (missingBlocks.size === 0) return;

  const blocks = [...missingBlocks];
  const timestampByBlock = new Map<string, string>();

  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(BLOCK_FETCH_CONCURRENCY, blocks.length) },
    async () => {
      while (true) {
        const i = cursor++;
        if (i >= blocks.length) return;
        const blockNum = blocks[i]!;
        try {
          const block = await alchemyRpc<{ timestamp?: string } | null>(
            network,
            "eth_getBlockByNumber",
            [blockNum, false],
          );
          const tsHex = block?.timestamp;
          if (tsHex) {
            const seconds = Number.parseInt(tsHex, 16);
            if (Number.isFinite(seconds)) {
              timestampByBlock.set(
                blockNum,
                new Date(seconds * 1000).toISOString(),
              );
            }
          }
        } catch (e) {
          // Best-effort: missing timestamp is better than a failed page.
          console.warn(
            `[alchemy] eth_getBlockByNumber(${blockNum}) failed`,
            e,
          );
        }
      }
    },
  );
  await Promise.all(workers);

  for (const t of transfers) {
    if (!t.blockTimestamp && t.blockNum) {
      const ts = timestampByBlock.get(t.blockNum);
      if (ts) t.blockTimestamp = ts;
    }
  }
}
