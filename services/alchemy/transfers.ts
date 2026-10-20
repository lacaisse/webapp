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
// the two queries in parallel and merge.
//
// Pagination is a block cutoff, not Alchemy's per-stream `pageKey`. The
// first version of this loader paged each stream with its own pageKey and
// encoded both in the cursor, assuming the merge would stay in block order
// across pages. It doesn't: when one stream is busy (a card that mostly
// pays) and the other quiet (rare top-ups), the quiet stream's page reaches
// years further back than the busy one's, so page 1 ended in July while
// page 2 started back in December. Every page now queries both streams over
// `[0x0, toBlock]` (toBlock = cursor, `latest` on the first page) with
// `maxCount = pageSize` and no pageKey. A stream that returned a `pageKey`
// was truncated: it is complete only for blocks strictly above its oldest
// returned block (rows in that block may continue past the cut). So:
//
//   - neither stream truncated → the range is exhausted: emit everything,
//     no next cursor;
//   - else cutoff = max over truncated streams of their oldest block; emit
//     rows with block > cutoff (complete in both streams) and continue at
//     `toBlock = cutoff`. Alchemy's toBlock is inclusive, so the held-back
//     rows at the cutoff come back on the next page, and none of them was
//     emitted here, so there are no duplicates.
//
// A page therefore holds between 1 and 2 × pageSize rows. Callers that
// walk the whole history (token audit, payouts, the MCP tools) only need
// the cursor to run dry, which it does; the dashboard tables just show a
// slightly uneven page length.

const HEX_BLOCK = /^0x[0-9a-f]+$/i;

export function encodeBlockCursor(toBlock: bigint): string {
  return Buffer.from(
    JSON.stringify({ b: `0x${toBlock.toString(16)}` }),
  ).toString("base64url");
}

/**
 * The `toBlock` (hex) a cursor carries, or null when the cursor is malformed
 * — including a cursor from the old two-pageKey scheme still sitting in a
 * bookmarked `?cursor=` URL. Callers treat null as "first page" rather than
 * failing the request: the cursor is a convenience, the data is the same.
 */
export function decodeBlockCursor(s: string | null | undefined): string | null {
  if (!s) return null;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(s, "base64url").toString("utf8"),
    );
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    const b = (parsed as Record<string, unknown>).b;
    if (typeof b !== "string" || !HEX_BLOCK.test(b)) return null;
    return `0x${BigInt(b).toString(16)}`;
  } catch {
    return null;
  }
}

function blockOf(t: AlchemyTransfer): bigint {
  return BigInt(t.blockNum || "0x0");
}

// Alchemy's ERC-20 uniqueId is `${hash}:log:${logIndex}` (decimal); the log
// index is block-wide, so it orders rows within one block.
function logIndexOf(t: AlchemyTransfer): number {
  const m = /:log:(\d+)$/.exec(t.uniqueId);
  return m ? Number(m[1]) : -1;
}

/** Block desc, then log index desc. */
function compareDesc(a: AlchemyTransfer, b: AlchemyTransfer): number {
  const ab = blockOf(a);
  const bb = blockOf(b);
  if (bb > ab) return 1;
  if (bb < ab) return -1;
  return logIndexOf(b) - logIndexOf(a);
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

  const toBlock = decodeBlockCursor(opts.cursor) ?? "latest";

  const query = (dir: { fromAddress?: string; toAddress?: string }) =>
    fetchTransfersPage(network, {
      contractAddress: opts.contractAddress,
      pageSize: opts.pageSize,
      toBlock,
      ...dir,
    });
  const streams = await Promise.all([
    query({ fromAddress: opts.account }),
    query({ toAddress: opts.account }),
  ]);

  // Dedupe self-transfers (same uniqueId from both queries), then order.
  const byId = new Map<string, AlchemyTransfer>();
  for (const s of streams) for (const t of s.transfers) byId.set(t.uniqueId, t);
  const merged = [...byId.values()].sort(compareDesc);

  // Oldest block of each truncated stream (one that returned a pageKey).
  const truncatedOldest: bigint[] = [];
  for (const s of streams) {
    if (!s.pageKey || s.transfers.length === 0) continue;
    let oldest = blockOf(s.transfers[0]!);
    for (const t of s.transfers) if (blockOf(t) < oldest) oldest = blockOf(t);
    truncatedOldest.push(oldest);
  }

  let transfers: AlchemyTransfer[];
  let nextPageKey: string | null;
  if (truncatedOldest.length === 0) {
    transfers = merged;
    nextPageKey = null;
  } else {
    const cutoff = truncatedOldest.reduce((a, b) => (b > a ? b : a));
    transfers = merged.filter((t) => blockOf(t) > cutoff);
    if (transfers.length > 0) {
      nextPageKey = encodeBlockCursor(cutoff);
    } else {
      // Pathological: a whole stream page sits inside the cutoff block (at
      // least pageSize transfers of this token for one account in one
      // block). Holding everything back would loop forever on the same
      // cursor, so we emit the rows of that block we have and skip past it,
      // accepting that its rows beyond the first pageSize per stream are
      // lost. Rows below the cutoff (from the other stream) are not emitted:
      // they come back on the next page.
      transfers = merged.filter((t) => blockOf(t) === cutoff);
      nextPageKey = cutoff > BigInt(0) ? encodeBlockCursor(cutoff - BigInt(1)) : null;
    }
  }

  await hydrateMissingTimestamps(network, transfers);
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
    fromBlock?: string;
    toBlock?: string;
    order?: "asc" | "desc";
  },
): Promise<{ transfers: AlchemyTransfer[]; pageKey?: string }> {
  const params: Record<string, unknown> = {
    fromBlock: opts.fromBlock ?? "0x0",
    toBlock: opts.toBlock ?? "latest",
    contractAddresses: [opts.contractAddress],
    category: ["erc20"],
    order: opts.order ?? "desc",
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

// Estimate the block-number range covering [fromMs, toMs] on a chain, by
// sampling the chain's recent average block time. Approximate — callers should
// widen with a margin and filter by the real block timestamp — but it lets us
// bound a getAssetTransfers query to a past date window instead of walking the
// whole history back from `latest` (infeasible for a very active account).
export async function estimateBlockRange(opts: {
  chainId: number;
  fromMs: number;
  toMs: number;
  marginBlocks?: number;
}): Promise<{ fromBlock: number; toBlock: number } | null> {
  const network = alchemyNetwork(opts.chainId);
  if (!network) return null;

  const latest = await alchemyRpc<{ number: string; timestamp: string } | null>(
    network,
    "eth_getBlockByNumber",
    ["latest", false],
  );
  if (!latest) return null;
  const latestNum = Number.parseInt(latest.number, 16);
  const latestMs = Number.parseInt(latest.timestamp, 16) * 1000;

  // Sample a block well behind head to measure average block time over a span
  // (robust to short-term jitter). Fall back to a nominal 5s if unavailable.
  const sampleNum = Math.max(1, latestNum - 50_000);
  const sample = await alchemyRpc<{ timestamp: string } | null>(
    network,
    "eth_getBlockByNumber",
    ["0x" + sampleNum.toString(16), false],
  );
  const sampleMs = sample ? Number.parseInt(sample.timestamp, 16) * 1000 : NaN;
  const blockTimeMs =
    Number.isFinite(sampleMs) && latestNum > sampleNum
      ? (latestMs - sampleMs) / (latestNum - sampleNum)
      : 5000;

  const margin = opts.marginBlocks ?? 1000;
  const estimate = (ms: number) =>
    Math.round(latestNum - (latestMs - ms) / blockTimeMs);
  const fromBlock = Math.max(0, estimate(opts.fromMs) - margin);
  const toBlock = Math.min(latestNum, estimate(opts.toMs) + margin);
  return { fromBlock, toBlock: Math.max(toBlock, fromBlock) };
}

// One page of ERC-20 transfers INTO `toAccount` within a fixed block range,
// oldest-first. Unlike listTransfersForAccount (which merges both directions and
// walks all history from head), this is a single-direction, block-bounded query
// — the right shape for "find the mints on this account during a past window".
export async function listIncomingTransfersInRange(opts: {
  chainId: number;
  contractAddress: string;
  toAccount: string;
  fromBlock: number;
  toBlock: number;
  pageSize: number;
  cursor?: string | null;
}): Promise<ListTransfersResult> {
  const network = alchemyNetwork(opts.chainId);
  if (!network) {
    throw new Error(`Alchemy: unsupported chain id ${opts.chainId}`);
  }
  const { transfers, pageKey } = await fetchTransfersPage(network, {
    contractAddress: opts.contractAddress,
    pageSize: opts.pageSize,
    pageKey: opts.cursor,
    toAddress: opts.toAccount,
    fromBlock: "0x" + Math.max(0, opts.fromBlock).toString(16),
    toBlock: "0x" + Math.max(opts.fromBlock, opts.toBlock).toString(16),
    order: "asc",
  });
  await hydrateMissingTimestamps(network, transfers);
  return { transfers, nextPageKey: pageKey ?? null };
}

// The outgoing counterpart of listIncomingTransfersInRange: one page of ERC-20
// transfers OUT of `fromAccount` within a fixed block range, oldest-first. The
// right shape for "find the burns leaving this account during a past window"
// (e.g. `refund` orders settled by burning the place's tokens).
export async function listOutgoingTransfersInRange(opts: {
  chainId: number;
  contractAddress: string;
  fromAccount: string;
  fromBlock: number;
  toBlock: number;
  pageSize: number;
  cursor?: string | null;
}): Promise<ListTransfersResult> {
  const network = alchemyNetwork(opts.chainId);
  if (!network) {
    throw new Error(`Alchemy: unsupported chain id ${opts.chainId}`);
  }
  const { transfers, pageKey } = await fetchTransfersPage(network, {
    contractAddress: opts.contractAddress,
    pageSize: opts.pageSize,
    pageKey: opts.cursor,
    fromAddress: opts.fromAccount,
    fromBlock: "0x" + Math.max(0, opts.fromBlock).toString(16),
    toBlock: "0x" + Math.max(opts.fromBlock, opts.toBlock).toString(16),
    order: "asc",
  });
  await hydrateMissingTimestamps(network, transfers);
  return { transfers, nextPageKey: pageKey ?? null };
}
