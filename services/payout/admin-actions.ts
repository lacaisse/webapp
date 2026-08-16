// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { refresh } from "next/cache";

import { getBalances } from "@/services/alchemy/balances";
import { formatTokenAmount } from "@/services/alchemy/format";
import { listTransfersForAccount } from "@/services/alchemy/transfers";
import { requireFundRole } from "@/services/auth/dal";
import { getCitizenPayClient } from "@/services/citizenpay/client";
import type {
  AddableOrdersSummary,
  ArchivedPayout,
  PayoutOrder,
  PayoutStatus,
  RejectedOrder,
} from "@/services/citizenpay/types";
import { Prisma } from "@/services/db/generated/client";
import { prisma } from "@/services/db/prisma";

import type { AutoMatchResult, ArchiveOrdersItemResult } from "./match";
import * as ops from "./operations";
import { resolveOrderReceipts, type TxReceiptStatus } from "./receipts";
import { AddableOrdersRangeSchema, toRfc3339, TX_HASH } from "./schemas";

// Payout lifecycle, driven from Payments → Payouts.
//
// The actual work lives in `./operations.ts`, which takes the fund as an
// argument so the MCP tools (services/mcp/payout-tools.ts) run the same code
// with the same guards. These actions are the dashboard's trust boundary:
// authorize via requireFundRole (fund from the host), translate in the
// operator's locale, and add the client-router `refresh()` that only a Server
// Action may call. Nothing here should grow logic of its own.

// Build the operations context for the current (host-derived) fund.
async function ctx() {
  const t = await getTranslations();
  const { fund, user } = await requireFundRole("ADMIN");
  return { fund, userId: user.id, t: (key: string) => t(key as never) };
}

// Result shapes the dashboard components import. Declared in ./operations and
// re-exported here so the UI keeps one import site (type-only — erased before
// the "use server" transform runs).
export type {
  CreatePayoutResult,
  CreatePayoutOrderResult,
  FixOrderResult,
  PayoutStatusResult,
  PlanPlaceMintsDebug,
  PlanPlaceMintsResult,
  PreviewPayoutResult,
  SetManualDeductionResult,
} from "./operations";

export type ArchiveOrderResult = ops.ArchiveOrderResult;
export type BurnPayoutResult = ops.BurnPayoutResult;
export type CompletePayoutResult = ops.CompletePayoutResult;
export type CreatePayoutPaymentResult = { error: string } | { ok: true };
export type FeeTransferActionResult = ops.FeeTransferOutcome;

// =============================================================================
// Drafts → payout
// =============================================================================

export async function previewPayoutDraftAction(input: {
  placeId: string;
  from: string;
  to: string;
}): Promise<ops.PreviewPayoutResult> {
  return ops.previewPayoutDraft(await ctx(), input);
}

export async function createPayoutAction(input: {
  placeId: string;
  from: string;
  to: string;
}): Promise<ops.CreatePayoutResult> {
  return ops.createPayout(await ctx(), input);
}

// =============================================================================
// Order verification (read-only helpers for the detail page)
// =============================================================================

// Resolve a batch of order settlement hashes via the bundler. Called
// progressively from the client so the orders table can render immediately
// and fill in confirmed/issues as each batch lands (rather than blocking the
// whole panel server-side). Keys are the input hashes; missing/unresolvable
// hashes come back as "pending".
export type ReceiptCheckResult = Record<string, TxReceiptStatus>;

export async function checkPayoutReceiptsAction(input: {
  hashes: string[];
}): Promise<ReceiptCheckResult> {
  const { fund } = await requireFundRole("ADMIN");
  const out: ReceiptCheckResult = {};
  const map = await resolveOrderReceipts({
    chainId: fund.tokenChainId,
    hashes: input.hashes,
  });
  for (const h of input.hashes) out[h] = map.get(h)?.status ?? "pending";
  return out;
}

// Sanity-check a hash the operator wants to record by hand, before they commit
// to it. Resolves the receipt via the bundler: "success" means it's mined and
// didn't revert (safe to record silently); anything else ("reverted",
// "pending", or "unavailable" when the lookup failed) is surfaced as a warning
// the operator must explicitly override.
export type OrderTxHashCheck = {
  status: TxReceiptStatus | "unavailable";
};

export async function checkOrderTxHashAction(input: {
  txHash: string;
}): Promise<OrderTxHashCheck> {
  const { fund } = await requireFundRole("ADMIN");
  const hash = input.txHash.trim();
  if (!TX_HASH.test(hash)) return { status: "unavailable" };
  try {
    const map = await resolveOrderReceipts({
      chainId: fund.tokenChainId,
      hashes: [hash],
    });
    return { status: map.get(hash)?.status ?? "pending" };
  } catch (e) {
    console.error("[payout] checkOrderTxHash failed", hash, e);
    return { status: "unavailable" };
  }
}

// Payer account context for the Fix dialog: current on-chain balance + recent
// transfers, so the operator can sanity-check the account holds (and held)
// enough before burning from it. Amounts are token-unit Decimal strings.
export type PayerTransfer = {
  hash: string;
  date: string | null;
  amount: string;
  direction: "in" | "out";
};
export type PayerAccountResult =
  | { error: string }
  | { ok: true; balance: string | null; transfers: PayerTransfer[] };

export async function getPayerAccountAction(input: {
  account: string;
}): Promise<PayerAccountResult> {
  const t = await getTranslations("fund.payments.settlement.errors");
  const { fund } = await requireFundRole("ADMIN");

  if (!fund.tokenAddress) {
    return { ok: true, balance: null, transfers: [] };
  }
  try {
    const account = input.account.toLowerCase();
    const [balances, history] = await Promise.all([
      getBalances({
        chainId: fund.tokenChainId,
        contractAddress: fund.tokenAddress,
        addresses: [account],
      }),
      listTransfersForAccount({
        chainId: fund.tokenChainId,
        contractAddress: fund.tokenAddress,
        account,
        pageSize: 8,
      }),
    ]);
    const balance = balances[0]
      ? formatTokenAmount(balances[0].rawBalance, fund.tokenDecimals)
      : null;
    const transfers: PayerTransfer[] = history.transfers.map((tx) => ({
      hash: tx.hash,
      date: tx.blockTimestamp,
      amount: formatTokenAmount(tx.rawValue, fund.tokenDecimals),
      direction: tx.from.toLowerCase() === account ? "out" : "in",
    }));
    return { ok: true, balance, transfers };
  } catch (e) {
    console.error("[payout] getPayerAccount failed", input.account, e);
    return { error: t("payerFailed") };
  }
}

// An order with no on-chain payer account was paid by bank transfer; the
// incoming transfer carries `cp-order-{orderId}` in its reference. We surface
// the matching transfer in the Fix dialog so the operator can confirm the
// fiat actually landed before minting (the mint has no burn to back it).
export type OrderBankMatch = {
  id: string;
  direction: "INCOMING" | "OUTGOING";
  occurredAt: string; // ISO 8601
  amount: string; // unsigned magnitude, 2dp
  currency: string;
  counterpartName: string | null;
  reference: string | null;
};

export type FindOrderBankTransactionResult =
  | { error: string }
  | { ok: true; transaction: OrderBankMatch | null };

export async function findOrderBankTransactionAction(input: {
  orderId: number;
}): Promise<FindOrderBankTransactionResult> {
  const t = await getTranslations("fund.payments.settlement.errors");
  const { fund } = await requireFundRole("ADMIN");

  const ref = `cp-order-${input.orderId}`;
  try {
    // `contains` narrows in SQL; the regex guard rejects prefix collisions
    // (e.g. cp-order-447 inside cp-order-44790) by requiring no trailing
    // digit. Banks normalise references inconsistently — we see both
    // `cp-order-43414` and `CP-ORDER-43414` in the wild — so both the SQL
    // narrow and the JS guard are case-insensitive.
    const guard = new RegExp(`cp-order-${input.orderId}(?!\\d)`, "i");
    const candidates = await prisma.bankTransaction.findMany({
      where: {
        fundId: fund.id,
        OR: [
          { counterpartReference: { contains: ref, mode: "insensitive" } },
          { remittanceInfo: { contains: ref, mode: "insensitive" } },
        ],
      },
      orderBy: { occurredAt: "desc" },
      take: 10,
      select: {
        id: true,
        direction: true,
        amount: true,
        currency: true,
        occurredAt: true,
        counterpartName: true,
        counterpartReference: true,
        remittanceInfo: true,
      },
    });
    const tx = candidates.find((b) =>
      guard.test(`${b.counterpartReference ?? ""} ${b.remittanceInfo ?? ""}`),
    );
    return {
      ok: true,
      transaction: tx
        ? {
            id: tx.id,
            direction: tx.direction,
            occurredAt: tx.occurredAt.toISOString(),
            amount: tx.amount.toFixed(2),
            currency: tx.currency,
            counterpartName: tx.counterpartName,
            reference: tx.counterpartReference ?? tx.remittanceInfo ?? null,
          }
        : null,
    };
  } catch (e) {
    console.error("[payout] findOrderBankTransaction failed", input.orderId, e);
    return { error: t("payerFailed") };
  }
}

// =============================================================================
// Order reconciliation
// =============================================================================

export async function fixOrderAction(input: {
  payoutId: string;
  orderId: number;
  account: string | null;
  placeAccount: string | null;
  total: string;
  net: string;
  txHash?: string | null;
}): Promise<ops.FixOrderResult> {
  return ops.fixOrder(await ctx(), input);
}

export async function archiveOrderAction(input: {
  payoutId: string;
  orderId: number;
}): Promise<ops.ArchiveOrderResult> {
  return ops.archiveOrder(await ctx(), input);
}

export type ArchiveOrdersResult = { results: ArchiveOrdersItemResult[] };

export async function archiveOrdersAction(input: {
  payoutId: string;
  orderIds: number[];
}): Promise<ArchiveOrdersResult> {
  return { results: await ops.archiveOrders(await ctx(), input) };
}

export type AutoMatchOrdersResult = { results: AutoMatchResult[] };

export async function autoMatchPayerTransfersAction(input: {
  payoutId: string;
  orders: {
    orderId: number;
    account: string | null;
    total: string;
    completedAt: string | null;
  }[];
}): Promise<AutoMatchOrdersResult> {
  return { results: await ops.autoMatchPayerTransfers(await ctx(), input) };
}

export async function planPlaceMintMatchesAction(input: {
  payoutId: string;
  // The place account resolved on page render; used as a reliable fallback when
  // the per-call CP re-fetch returns nothing (it's occasionally empty).
  placeAccount?: string | null;
  orders: {
    orderId: number;
    net: string;
    createdAt: string | null;
    completedAt: string | null;
  }[];
}): Promise<ops.PlanPlaceMintsResult> {
  return ops.planPlaceMintMatches(await ctx(), input);
}

export async function planPlaceBurnMatchesAction(input: {
  payoutId: string;
  placeAccount?: string | null;
  orders: {
    orderId: number;
    total: string;
    createdAt: string | null;
    completedAt: string | null;
  }[];
}): Promise<ops.PlanPlaceMintsResult> {
  return ops.planPlaceBurnMatches(await ctx(), input);
}

export type RecordOrderHashesResult = { results: ArchiveOrdersItemResult[] };

export async function recordOrderHashesAction(input: {
  payoutId: string;
  entries: { orderId: number; txHash: string }[];
}): Promise<RecordOrderHashesResult> {
  return { results: await ops.recordOrderHashes(await ctx(), input) };
}

// =============================================================================
// Adding orders to a pending payout
// =============================================================================

export async function createPayoutOrderAction(input: {
  payoutId: string;
  /** Processor commission withheld at source — "0" for a bank transfer. */
  fees: string;
  /** The platform's cut on this order; omitted reads as "0". */
  payoutFee?: string;
  total: string;
  description: string | null;
}): Promise<ops.CreatePayoutOrderResult> {
  return ops.createPayoutOrder(await ctx(), input);
}

// One page of addable orders per request. 50 is CP's per-page cap; the operator
// pages with "load more" (offset) rather than us shipping the whole window.
const ADDABLE_ORDERS_PAGE_SIZE = 50;

export type PreviewAddableOrdersResult =
  | { error: string }
  | {
      ok: true;
      orders: PayoutOrder[];
      summary: AddableOrdersSummary;
      total: number;
      limit: number;
      offset: number;
    };

// Preview → deselect → submit: some orders miss a payout's original range (they
// arrived late, or fell just outside the window). Both steps only work while the
// payout is pending (CP returns 409 otherwise).
export async function previewAddableOrdersAction(input: {
  payoutId: string;
  from: string;
  to: string;
  offset?: number;
}): Promise<PreviewAddableOrdersResult> {
  const t = await getTranslations("fund.payments.settlement.errors");
  const { fund } = await requireFundRole("ADMIN");

  const parsed = AddableOrdersRangeSchema.safeParse(input);
  if (!parsed.success) {
    const key = parsed.error.issues[0]?.message ?? "addOrdersFailed";
    return { error: t(key.split(".").pop() as never) };
  }

  try {
    const client = getCitizenPayClient(fund);
    const page = await client.getAddableOrders(parsed.data.payoutId, {
      from: toRfc3339(parsed.data.from),
      to: toRfc3339(parsed.data.to),
      limit: ADDABLE_ORDERS_PAGE_SIZE,
      offset: Math.max(0, input.offset ?? 0),
    });
    return {
      ok: true,
      orders: page.orders,
      summary: page.summary,
      total: page.total,
      limit: page.limit,
      offset: page.offset,
    };
  } catch (e) {
    console.error("[payout] previewAddableOrders failed", e);
    return { error: t("addOrdersFailed") };
  }
}

export type AddOrdersResult =
  | { error: string }
  | { error: string; rejected: RejectedOrder[] }
  | { ok: true; assigned: number; payout: ArchivedPayout };

export async function addOrdersAction(input: {
  payoutId: string;
  orderIds: number[];
}): Promise<AddOrdersResult> {
  return ops.addOrders(await ctx(), input);
}

// Incoming bank transactions the operator can turn into a manual order. Read
// from our local mirror (populated by the bank-sync cron / full-sync), newest
// first. `reference` is what we'd drop into the order description.
export type PickableBankTransaction = {
  id: string;
  occurredAt: string; // ISO 8601
  amount: string; // unsigned magnitude, 2dp
  currency: string;
  counterpartName: string | null;
  reference: string | null;
};

export type ListIncomingBankTransactionsResult =
  | { error: string }
  | { ok: true; transactions: PickableBankTransaction[]; nextCursor: string | null };

// One screenful per request. The operator searches / "loads more" instead of
// us shipping the whole (potentially huge) transaction history up front.
const BANK_TX_PAGE_SIZE = 20;

// Strip combining diacritics so a search for "François" also matches the
// un-accented "FRANCOIS" that bank (SEPA) feeds emit. NFD separates a letter
// from its accent; we drop the accent range. Case is handled separately by
// Prisma's `mode: "insensitive"`.
function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// Search + keyset-paginate the incoming bank transactions. `cursor` is the id
// of the last row from the previous page; pass it back to fetch the next page
// (newest-first). `search` matches counterpart name / reference / remittance /
// IBAN case-insensitively, and the exact amount when it parses as a number.
export async function listIncomingBankTransactionsAction(input?: {
  search?: string;
  cursor?: string;
}): Promise<ListIncomingBankTransactionsResult> {
  const t = await getTranslations("fund.payments.settlement.errors");
  const { fund } = await requireFundRole("ADMIN");

  const search = input?.search?.trim() ?? "";
  const cursor = input?.cursor?.trim() || null;

  try {
    const where: Prisma.BankTransactionWhereInput = {
      fundId: fund.id,
      direction: "INCOMING",
    };
    if (search) {
      // Match the term as typed AND with accents stripped, so "François" finds
      // the un-accented "FRANCOIS" that bank feeds emit. Dedupe in case the
      // term has no accents. Case is handled by `mode: "insensitive"`.
      const terms = [...new Set([search, stripAccents(search)])];
      const or: Prisma.BankTransactionWhereInput[] = terms.flatMap((term) => {
        const insensitive = { contains: term, mode: "insensitive" as const };
        return [
          { counterpartName: insensitive },
          { counterpartReference: insensitive },
          { remittanceInfo: insensitive },
          { counterpartIban: insensitive },
        ];
      });
      // Allow "2.40" / "2,40" to match the transaction amount exactly.
      const amount = Number(search.replace(",", "."));
      if (Number.isFinite(amount)) or.push({ amount });
      where.OR = or;
    }

    // Fetch one extra row to learn whether another page exists without a
    // second count query. Tiebreak occurredAt with id so the keyset cursor
    // is stable across same-second transactions.
    const rows = await prisma.bankTransaction.findMany({
      where,
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: BANK_TX_PAGE_SIZE + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        amount: true,
        currency: true,
        occurredAt: true,
        counterpartName: true,
        counterpartReference: true,
        remittanceInfo: true,
      },
    });

    const hasMore = rows.length > BANK_TX_PAGE_SIZE;
    const page = hasMore ? rows.slice(0, BANK_TX_PAGE_SIZE) : rows;

    return {
      ok: true,
      transactions: page.map((b) => ({
        id: b.id,
        occurredAt: b.occurredAt.toISOString(),
        amount: b.amount.toFixed(2),
        currency: b.currency,
        counterpartName: b.counterpartName,
        reference: b.counterpartReference ?? b.remittanceInfo ?? null,
      })),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  } catch (e) {
    console.error("[payout] listIncomingBankTransactions failed", e);
    return { error: t("ordersFailed") };
  }
}

// =============================================================================
// Settlement
// =============================================================================

// Lightweight status poll for the awaiting-signature screen — returns the
// live status WITHOUT revalidating (the client only triggers a refresh when
// the status actually changes, so polling doesn't churn the whole page).
export async function pollPayoutStatusAction(input: {
  payoutId: string;
}): Promise<{ status: PayoutStatus | null }> {
  const { fund } = await requireFundRole("ADMIN");
  try {
    const { status } = await getCitizenPayClient(fund).getPayoutStatus(
      input.payoutId,
    );
    return { status };
  } catch (e) {
    console.warn("[payout] pollPayoutStatus failed", input.payoutId, e);
    return { status: null };
  }
}

export async function getPayoutStatusAction(input: {
  payoutId: string;
}): Promise<ops.PayoutStatusResult> {
  // /status self-heals (flips to complete + sends email when Ponto confirms),
  // and the detail page re-reads the signing URL — ops revalidates the detail
  // path for us.
  return ops.getPayoutStatus(await ctx(), input.payoutId);
}

// Just kicks off the bank payment. The signing URL is not returned here — the
// dashboard reads it from `GET /payouts/{id}/status` (canonical, survives
// reloads), so we only need success/failure + the revalidate ops did.
export async function createPayoutPaymentAction(input: {
  payoutId: string;
}): Promise<CreatePayoutPaymentResult> {
  const res = await ops.createPayoutPayment(await ctx(), input.payoutId);
  return "error" in res ? { error: res.error } : { ok: true };
}

// Burn the place's tokens for this payout and report the hash to CP.
// Irreversible — the UI confirms before firing.
export async function burnPayoutAction(input: {
  payoutId: string;
}): Promise<ops.BurnPayoutResult> {
  return ops.burnPayout(await ctx(), input.payoutId);
}

// Run (or retry) just the fee sweep for an already-burned payout.
export async function feeTransferAction(input: {
  payoutId: string;
}): Promise<FeeTransferActionResult> {
  const res = await ops.feeTransfer(await ctx(), input.payoutId);
  // Refresh the client router so the process panel drops the "fees not yet
  // transferred" affordance. Must run in the Server Action — `refresh` throws
  // if called from a Client Component.
  if ("ok" in res) refresh();
  return res;
}

// =============================================================================
// Settlement period
// =============================================================================

export async function updatePayoutPeriodAction(input: {
  payoutId: string;
  from: string;
  to: string;
}): Promise<ops.UpdatePayoutPeriodResult> {
  const res = await ops.updatePayoutPeriod(await ctx(), input);
  // Re-render the detail header, where the period sits under the place name.
  if ("ok" in res) refresh();
  return res;
}

// =============================================================================
// Manual deduction
// =============================================================================

export async function setManualDeductionAction(input: {
  payoutId: string;
  amount: string;
  comment: string | null;
}): Promise<ops.SetManualDeductionResult> {
  const res = await ops.setManualDeduction(await ctx(), input);
  // Re-render the detail header (net + deduction row) client-side.
  if ("ok" in res) refresh();
  return res;
}

export async function clearManualDeductionAction(input: {
  payoutId: string;
}): Promise<ops.SetManualDeductionResult> {
  const res = await ops.clearManualDeduction(await ctx(), input.payoutId);
  if ("ok" in res) refresh();
  return res;
}

// Admin override: mark a payout complete without burning or paying — for when
// the treasury settled with the merchant another way. Confirmed in the UI
// before firing (it bypasses settlement and can't be undone).
export async function completePayoutAction(input: {
  payoutId: string;
}): Promise<ops.CompletePayoutResult> {
  return ops.completePayout(await ctx(), input.payoutId);
}
