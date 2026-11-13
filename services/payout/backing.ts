// SPDX-License-Identifier: AGPL-3.0-or-later

import { formatUnits, parseUnits } from "viem";

import { isAdjustmentLeg } from "./match";
import { fromCents, orderWalletCredit, payoutWalletOutflow, toCents } from "./money";

// =============================================================================
// Payout backing — is this payout covered by tokens before it is paid?
// =============================================================================
// Pure (no I/O, no server-only): operations.ts::checkPayoutBacking reads the
// chain and hands the results in here, so the verdicts and the sentences an
// agent reads are pinned by unit tests.
//
// Two checks, both born of the 2026-11-13 La Regina payout (36 orders, 25 of
// them duplicate rows: several order ids carried the SAME settlement hash, and
// each hash was ONE real on-chain event — paid 554.24 EUR too much):
//
//   1. Shared settlement hashes. Orders that are not adjustment legs and that
//      carry the same tx hash must, together, have credited the place their
//      summed wallet credit (total − fees) in that one transaction — or at
//      least total − fees − payoutFee, which is what historical mints
//      credited (e.g. 55.50 with payoutFee 0.94 → 54.56 to the place). A real
//      batch (one tx, N transfers to the place that add up) is `covered`; a
//      duplicated row (one transfer for N orders, or a transfer that went to
//      another account) is `uncovered`; a tx whose logs we could not read is
//      `unverified`.
//   2. The place wallet's balance against what settling the payout removes
//      (payoutWalletOutflow: net + retained cut). Not applicable once a burn
//      is recorded or the payout is burnt/complete — the wallet is then
//      legitimately empty.
//
// Refund / correction / topup legs are never grouped: they are the subtract
// side of the payout math and, hashless, ledger entries (see match.ts).

export type Coverage = "covered" | "uncovered" | "unverified";

/** The order fields the grouping needs (a PayoutOrder fits). */
export type BackingOrder = {
  id: number;
  status: string;
  txHash: string | null;
  total: string;
  fees: string;
  /** The order's platform payout fee (PayoutOrder.payoutFee); missing = 0. */
  payoutFee?: string | null;
};

export type SharedSettlementGroup = {
  /** Lower-cased. */
  txHash: string;
  orderIds: number[];
  /** Sum of the orders' wallet credits (total − fees), EUR decimal. */
  required: string;
  /** Sum of total − fees − payoutFee: the least a historical mint credited
   *  (some minted net of the payout fee). The verdict compares against it. */
  minimum: string;
};

/** A decoded ERC-20 Transfer log. Addresses as they came (compared lower-cased). */
export type TokenTransfer = {
  token: string;
  from: string;
  to: string;
  value: bigint;
};

/** One shared-hash group with its verdict. JSON-safe (amounts as token decimals). */
export type SharedSettlementCheck = {
  txHash: string;
  orderIds: number[];
  /** Token amount the orders need credited to the place (total − fees). */
  required: string;
  /** Lower bound the verdict uses (total − fees − payoutFee). */
  minimum: string;
  /** Token amount the tx moved to the place; null when unverified. */
  found: string | null;
  verdict: Coverage;
};

export type BalanceCheck =
  | { verdict: "ok"; balance: string; required: string }
  | { verdict: "short"; balance: string; required: string; shortfall: string }
  | { verdict: "unverified"; required: string | null }
  | { verdict: "notApplicable"; reason: "burnRecorded" };

export type OrdersRead = "ok" | "truncated" | "failed";

export type PayoutBackingReport = {
  /** Shared-hash groups that are NOT covered (uncovered or unverified). */
  duplicates: SharedSettlementCheck[];
  balance: BalanceCheck;
  /** True when any group is uncovered/unverified, the balance is short or
   *  unverified, or the orders could not all be read. */
  blocking: boolean;
  /** Short English sentences for agents (order ids, hash, amounts). */
  warnings: string[];
  /** Every shared-hash group, covered ones included (per-order coverage). */
  settlements: SharedSettlementCheck[];
};

export const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * Orders sharing one settlement hash (case-insensitive), adjustment legs and
 * hashless orders excluded. Only groups of two or more come back, in the
 * order their first order appears.
 */
export function sharedSettlementGroups(
  orders: readonly BackingOrder[],
): SharedSettlementGroup[] {
  const byHash = new Map<string, BackingOrder[]>();
  for (const o of orders) {
    if (isAdjustmentLeg(o.status)) continue;
    const hash = o.txHash?.trim().toLowerCase();
    if (!hash) continue;
    const list = byHash.get(hash);
    if (list) list.push(o);
    else byHash.set(hash, [o]);
  }
  const groups: SharedSettlementGroup[] = [];
  for (const [txHash, list] of byHash) {
    if (list.length < 2) continue;
    const cents = list.reduce((sum, o) => sum + toCents(orderWalletCredit(o)), 0);
    const feeCents = list.reduce((sum, o) => sum + toCents(o.payoutFee || "0"), 0);
    groups.push({
      txHash,
      orderIds: list.map((o) => o.id),
      required: fromCents(cents),
      minimum: fromCents(cents - feeCents),
    });
  }
  return groups;
}

/** Decode the ERC-20 Transfer logs of a receipt; anything malformed is skipped. */
export function decodeTransferLogs(
  logs: readonly { address: string; topics: readonly string[]; data: string }[],
): TokenTransfer[] {
  const out: TokenTransfer[] = [];
  for (const l of logs) {
    if (l.topics[0]?.toLowerCase() !== TRANSFER_TOPIC || l.topics.length < 3) continue;
    let value: bigint;
    try {
      value = BigInt(l.data);
    } catch {
      continue;
    }
    out.push({
      token: l.address,
      from: topicAddress(l.topics[1]),
      to: topicAddress(l.topics[2]),
      value,
    });
  }
  return out;
}

function topicAddress(topic: string): string {
  return `0x${topic.slice(-40)}`.toLowerCase();
}

/**
 * Verdict per group. `transfersByHash` holds, per lower-cased hash, the
 * decoded Transfer logs of that tx — or null / no entry when they could not
 * be read (→ `unverified`). Only transfers of `token` to `placeAccount`
 * count. A null place account or token config makes every group unverified.
 */
export function evaluateSharedSettlements(
  groups: readonly SharedSettlementGroup[],
  transfersByHash: ReadonlyMap<string, readonly TokenTransfer[] | null>,
  opts: { token: string | null; placeAccount: string | null; decimals: number | null },
): SharedSettlementCheck[] {
  const { token, placeAccount, decimals } = opts;
  return groups.map((g) => {
    const transfers = transfersByHash.get(g.txHash.toLowerCase());
    if (!transfers || !token || !placeAccount || decimals == null) {
      return { ...g, found: null, verdict: "unverified" as const };
    }
    const t = token.toLowerCase();
    const to = placeAccount.toLowerCase();
    const foundUnits = transfers
      .filter((x) => x.token.toLowerCase() === t && x.to.toLowerCase() === to)
      .reduce((sum, x) => sum + x.value, BigInt(0));
    // Covered at the lower bound: historical mints credited total − fees −
    // payoutFee, so the full total − fees would flag genuine batches.
    const minimumUnits = parseUnits(g.minimum, decimals);
    return {
      ...g,
      found: formatUnits(foundUnits, decimals),
      verdict: foundUnits >= minimumUnits ? ("covered" as const) : ("uncovered" as const),
    };
  });
}

/**
 * The place wallet against what settling the payout removes. Not applicable
 * once a burn is recorded or the live status is burnt / complete; unverified
 * when the balance could not be read.
 */
export function evaluateBalance(args: {
  balanceUnits: bigint | null;
  payout: { totalAmount: string; totalFees: string; burnTxHashes?: readonly string[] | null };
  status?: string | null;
  decimals: number | null;
}): BalanceCheck {
  const { payout, status } = args;
  if ((payout.burnTxHashes?.length ?? 0) > 0 || status === "burnt" || status === "complete") {
    return { verdict: "notApplicable", reason: "burnRecorded" };
  }
  const required = payoutWalletOutflow(payout);
  if (args.balanceUnits == null || args.decimals == null) {
    return { verdict: "unverified", required };
  }
  const requiredUnits = parseUnits(required, args.decimals);
  const balance = formatUnits(args.balanceUnits, args.decimals);
  if (args.balanceUnits >= requiredUnits) return { verdict: "ok", balance, required };
  return {
    verdict: "short",
    balance,
    required,
    shortfall: formatUnits(requiredUnits - args.balanceUnits, args.decimals),
  };
}

/** Assemble the report: blocking flag + the sentences an agent reads. */
export function buildBackingReport(args: {
  settlements: readonly SharedSettlementCheck[];
  balance: BalanceCheck;
  ordersRead: OrdersRead;
  symbol?: string | null;
  placeAccount?: string | null;
}): PayoutBackingReport {
  const sym = args.symbol ? ` ${args.symbol}` : "";
  const warnings: string[] = [];

  if (args.ordersRead === "failed") {
    warnings.push(
      "The payout's orders could not be read, so duplicate settlement hashes were not checked.",
    );
  } else if (args.ordersRead === "truncated") {
    warnings.push(
      "The payout has more orders than could be read; duplicate settlement hashes were only checked on the orders that were.",
    );
  }

  const duplicates = args.settlements.filter((s) => s.verdict !== "covered");
  for (const d of duplicates) {
    const ids = d.orderIds.join(", ");
    if (d.verdict === "uncovered") {
      const over = fromCents(toCents(d.required) - toCents(d.found ?? "0"));
      const atLeast =
        d.minimum !== d.required
          ? ` (at least ${d.minimum}${sym} where the mint left out the payout fee)`
          : "";
      warnings.push(
        `Orders ${ids} share settlement tx ${d.txHash}: together they need ${d.required}${sym}${atLeast} credited to the place, but that tx moved only ${d.found ?? "0"}${sym} to the place account. Paying all of them overpays the merchant by up to ${over}${sym} (likely duplicate order rows).`,
      );
    } else {
      warnings.push(
        `Orders ${ids} share settlement tx ${d.txHash}; its transfers could not be read, so it is unverified that it credited the ${d.required}${sym} they need.`,
      );
    }
  }

  const b = args.balance;
  const wallet = args.placeAccount ? ` ${args.placeAccount}` : "";
  if (b.verdict === "short") {
    warnings.push(
      `The place wallet${wallet} holds ${b.balance}${sym}, but settling this payout removes ${b.required}${sym} (net + retained cut): short by ${b.shortfall}${sym}.`,
    );
  } else if (b.verdict === "unverified") {
    warnings.push(
      b.required
        ? `The place wallet balance could not be read, so it is unverified that it covers the ${b.required}${sym} settling this payout removes.`
        : "The payout or the place wallet balance could not be read, so the balance is unverified.",
    );
  }

  const blocking =
    args.ordersRead !== "ok" ||
    duplicates.length > 0 ||
    b.verdict === "short" ||
    b.verdict === "unverified";

  return {
    duplicates,
    balance: b,
    blocking,
    warnings,
    settlements: [...args.settlements],
  };
}

/**
 * Is a burn recorded on this payout? The live client never fills
 * `burnTxHashes` (neither the list, the detail nor the status wire carries
 * them), so an empty list proves nothing. Evidence of a burn: a hash, the live
 * status `burnt`, or a fee sweep (done or pending — it only exists on a burned
 * payout). `true` = evidence; `false` = certainly none (`pending` /
 * `payment-pending` without evidence: CP would say `burnt`); `null` = cannot
 * be told from here (`complete`, or an unknown status, without evidence — the
 * place wallet / token history on chain decides).
 */
export function burnRecordedFrom(e: {
  status: string | null | undefined;
  burnTxHashes?: readonly string[] | null;
  feeTransferTxHash?: string | null;
  feeTransferPending?: boolean | null;
}): boolean | null {
  if (
    (e.burnTxHashes?.length ?? 0) > 0 ||
    e.status === "burnt" ||
    !!e.feeTransferTxHash ||
    e.feeTransferPending === true
  ) {
    return true;
  }
  if (e.status === "pending" || e.status === "payment-pending") return false;
  return null;
}

/** One line per warning, for embedding in an error message. */
export function backingSummary(report: PayoutBackingReport): string {
  return report.warnings.join(" ");
}
