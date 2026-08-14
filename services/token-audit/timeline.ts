// SPDX-License-Identifier: AGPL-3.0-or-later

// Pure balance-timeline math for the account audit view (/token/account/[address]).
// Given an account's transfer history (newest first) and its current on-chain
// balance, reconstruct the running balance after every transfer by walking
// backwards from the present. The oldest row's implied "balance before" is the
// opening balance: 0 when the loaded history fully explains the current
// balance, anything else is an unexplained difference the auditor should see.
//
// All arithmetic is bigint on raw (pre-decimals) token units — token amounts
// can exceed Number.MAX_SAFE_INTEGER.

export type AuditTransfer = {
  uniqueId: string;
  blockNum: string; // hex
  hash: string;
  from: string;
  to: string;
  rawValue: string; // hex, pre-decimals
  blockTimestamp: string | null;
};

export type TimelineDirection = "in" | "out" | "self";

export type TimelineEntry = {
  transfer: AuditTransfer;
  direction: TimelineDirection;
  /** The other side of the transfer (the account itself for self-transfers). */
  counterparty: string;
  /** Signed effect on the account's balance in raw units (0 for self). */
  delta: bigint;
  /** The account's balance right after this transfer, in raw units. */
  balanceAfter: bigint;
};

export type BalanceTimeline = {
  /** Newest first, same order as the input. */
  entries: TimelineEntry[];
  totalIn: bigint;
  totalOut: bigint;
  /**
   * Balance implied *before* the oldest loaded transfer:
   * currentBalance − Σ deltas. With complete history this is 0; a non-zero
   * value means the loaded window doesn't explain the current balance.
   */
  openingBalance: bigint;
};

export function hexToBigInt(hex: string | null | undefined): bigint {
  if (!hex) return BigInt(0);
  const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex : `0x${hex}`;
  try {
    return BigInt(clean);
  } catch {
    return BigInt(0);
  }
}

// Alchemy uniqueIds end in the log index (e.g. "0x<hash>:log:45"). Within a
// block the log index is the on-chain execution order — the tie-breaker we
// need for a correct running balance when one block holds several transfers.
function logIndex(uniqueId: string): number {
  const match = /(\d+)$/.exec(uniqueId);
  return match ? Number.parseInt(match[1]!, 10) : 0;
}

/**
 * Sort transfers newest-first: block number descending, then log index
 * descending inside a block. Required before building a timeline — pages
 * accumulated from Alchemy's merged from/to streams are not globally ordered.
 */
export function sortNewestFirst<
  T extends { blockNum: string; uniqueId: string },
>(transfers: T[]): T[] {
  return transfers.slice().sort((a, b) => {
    const av = hexToBigInt(a.blockNum);
    const bv = hexToBigInt(b.blockNum);
    if (av !== bv) return av < bv ? 1 : -1;
    return logIndex(b.uniqueId) - logIndex(a.uniqueId);
  });
}

export function buildBalanceTimeline(opts: {
  account: string;
  /** Current on-chain balance in raw units. */
  currentBalance: bigint;
  /** Newest first (see sortNewestFirst). */
  transfers: AuditTransfer[];
}): BalanceTimeline {
  const self = opts.account.toLowerCase();
  let running = opts.currentBalance;
  let totalIn = BigInt(0);
  let totalOut = BigInt(0);

  const entries: TimelineEntry[] = opts.transfers.map((transfer) => {
    const from = transfer.from.toLowerCase();
    const to = transfer.to.toLowerCase();
    const value = hexToBigInt(transfer.rawValue);

    const direction: TimelineDirection =
      from === self && to === self ? "self" : to === self ? "in" : "out";
    const delta = direction === "in" ? value : direction === "out" ? -value : BigInt(0);
    if (direction === "in") totalIn += value;
    if (direction === "out") totalOut += value;

    const balanceAfter = running;
    running -= delta; // walk back to the balance before this transfer

    return {
      transfer,
      direction,
      counterparty:
        direction === "in" ? transfer.from : direction === "out" ? transfer.to : transfer.from,
      delta,
      balanceAfter,
    };
  });

  return { entries, totalIn, totalOut, openingBalance: running };
}

/**
 * Format a signed raw amount for display: "+12.5" / "−3" / "0", using the
 * shared no-float decimal expansion. The minus sign is U+2212 to match
 * tabular typography.
 */
export function formatSignedAmount(
  value: bigint,
  format: (raw: string) => string,
): string {
  if (value === BigInt(0)) return format("0");
  const abs = value < BigInt(0) ? -value : value;
  return `${value < BigInt(0) ? "−" : "+"}${format(abs.toString())}`;
}
