// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { revalidatePath } from "next/cache";

import { formatTokenAmount } from "@/services/alchemy/format";
import {
  estimateBlockRange,
  listIncomingTransfersInRange,
  listOutgoingTransfersInRange,
  listTransfersForAccount,
  type ListTransfersResult,
} from "@/services/alchemy/transfers";
import { CitizenPayApiError } from "@/services/citizenpay/api";
import { getCitizenPayClient } from "@/services/citizenpay/client";
import type { CitizenPayClient } from "@/services/citizenpay/client-interface";
import type {
  ArchivedPayout,
  Payout,
  PayoutDeduction,
  PayoutDraft,
  PayoutOrder,
  PayoutStatus,
  PayoutStatusDetail,
} from "@/services/citizenpay/types";
import type { Fund } from "@/services/db/generated/client";
import { ANNOTATION_TRIGGERS } from "@/services/transaction-annotation/annotate";
import { resolveOrEnqueueAnnotation } from "@/services/transaction-annotation/pending";
import { burnDirect, mintDirect, type Translate } from "@/services/token-operations/direct";

import {
  assignPlaceBurns,
  assignPlaceMints,
  autoMatchRoute,
  isConfirmableOrderStatus,
  matchPayerTransfer,
  type ArchiveOrdersItemResult,
  type AutoMatchResult,
  type MatchTransfer,
} from "./match";
import { resolveOrderReceipts, type TxReceipt } from "./receipts";
import {
  AddOrdersSchema,
  CreatePayoutOrderSchema,
  PayoutRangeSchema,
  SetManualDeductionSchema,
  toRfc3339,
  TX_HASH,
} from "./schemas";

// =============================================================================
// Payout engine — the fund comes in as an argument, never from the request host
// =============================================================================
// Every payout flow lives here so it can be driven from two trust boundaries:
//   - `admin-actions.ts` — dashboard server actions, fund from the host
//     (requireFundRole), UI revalidation and `refresh()` on top;
//   - `services/mcp/payout-tools.ts` — MCP tools, fund from a tool parameter
//     gated by requireFundAccessForUser (services/mcp/authz.ts).
// Both must move money the same way, so neither owns the logic. Callers inject
// a root next-intl translator (`t`), which is why these return ready-to-show
// strings without knowing whose locale they're speaking.

export type PayoutContext = {
  fund: Fund;
  /** Acting user — recorded as the triggering admin on annotations. */
  userId: string;
  t: Translate;
};

const ERR = "fund.payments.settlement.errors";

function err(ctx: PayoutContext, key: string): string {
  return ctx.t(`${ERR}.${key}`);
}

function client(ctx: PayoutContext): CitizenPayClient {
  return getCitizenPayClient(ctx.fund);
}

// CP's own error strings are admin-facing and usually actionable ("merchant
// not connected", "payout already paid", …) so we surface them directly;
// anything else degrades to a generic translated message with the detail
// logged server-side.
function toMessage(e: unknown, generic: string): string {
  if (e instanceof CitizenPayApiError && e.message) return e.message;
  return generic;
}

// Serialise a value for a log line with CR/LF stripped, so user-provided
// fields (payout id, dates, order ids) can't inject extra log entries
// (CodeQL js/log-injection).
function logSafe(value: unknown): string {
  return JSON.stringify(value).replace(/[\r\n]+/g, " ");
}

// =============================================================================
// Drafts & creation
// =============================================================================

export type ListDraftsResult =
  | { error: string }
  | { ok: true; drafts: PayoutDraft[] };

/**
 * Unsettled orders grouped by place — the amount each merchant is currently
 * owed but hasn't been put into a payout yet. Optional half-open `[from, to)`
 * window narrows the orders considered.
 */
export async function listPayoutDrafts(
  ctx: PayoutContext,
  range?: { from?: string; to?: string },
): Promise<ListDraftsResult> {
  try {
    const drafts = await client(ctx).listPayoutDrafts(
      range?.from || range?.to
        ? {
            ...(range.from ? { from: toRfc3339(range.from) } : {}),
            ...(range.to ? { to: toRfc3339(range.to) } : {}),
          }
        : undefined,
    );
    return { ok: true, drafts };
  } catch (e) {
    console.error("[payout] listPayoutDrafts failed", logSafe(range ?? null), e);
    return { error: toMessage(e, err(ctx, "previewFailed")) };
  }
}

export type PreviewPayoutResult =
  | { error: string }
  | {
      ok: true;
      orderCount: number;
      total: string;
      fees: string;
      net: string;
    };

export async function previewPayoutDraft(
  ctx: PayoutContext,
  input: { placeId: string; from: string; to: string },
): Promise<PreviewPayoutResult> {
  const parsed = PayoutRangeSchema.safeParse(input);
  if (!parsed.success) {
    return { error: ctx.t(parsed.error.issues[0]?.message ?? `${ERR}.previewFailed`) };
  }

  try {
    const preview = await client(ctx).previewPayoutDraft({
      placeId: parsed.data.placeId,
      from: toRfc3339(parsed.data.from),
      to: toRfc3339(parsed.data.to),
    });
    return {
      ok: true,
      orderCount: preview.orderCount,
      total: preview.total,
      fees: preview.fees,
      net: preview.net,
    };
  } catch (e) {
    console.error("[payout] previewPayoutDraft failed", logSafe(input), e);
    return { error: toMessage(e, err(ctx, "previewFailed")) };
  }
}

export type CreatePayoutResult =
  | { error: string }
  | { ok: true; payoutId: string; orderCount: number; net: string };

export async function createPayout(
  ctx: PayoutContext,
  input: { placeId: string; from: string; to: string },
): Promise<CreatePayoutResult> {
  const parsed = PayoutRangeSchema.safeParse(input);
  if (!parsed.success) {
    return { error: ctx.t(parsed.error.issues[0]?.message ?? `${ERR}.createFailed`) };
  }

  try {
    const created = await client(ctx).createPayout({
      placeId: parsed.data.placeId,
      from: toRfc3339(parsed.data.from),
      to: toRfc3339(parsed.data.to),
    });
    revalidatePath("/payments");
    return {
      ok: true,
      payoutId: created.payoutId,
      orderCount: created.orderCount,
      net: created.net,
    };
  } catch (e) {
    console.error("[payout] createPayout failed", logSafe(input), e);
    return { error: toMessage(e, err(ctx, "createFailed")) };
  }
}

// =============================================================================
// Status & listing
// =============================================================================

export type PayoutStatusResult =
  | { error: string }
  | { ok: true; status: PayoutStatus; detail: PayoutStatusDetail };

/**
 * Live status. Reading it self-heals on CP's side (a signed payout flips to
 * complete and the merchant email goes out), so this is also the "nudge
 * settlement forward" call.
 */
export async function getPayoutStatus(
  ctx: PayoutContext,
  payoutId: string,
  opts?: { redirectUrl?: string },
): Promise<PayoutStatusResult> {
  try {
    const detail = await client(ctx).getPayoutStatus(payoutId, opts);
    revalidatePath(`/payments/payouts/${payoutId}`);
    return { ok: true, status: detail.status, detail };
  } catch (e) {
    console.error("[payout] getPayoutStatus failed", logSafe(payoutId), e);
    return { error: toMessage(e, err(ctx, "statusFailed")) };
  }
}

export type PayoutListState = "pending" | "completed" | "all";

export type ListPayoutsResult =
  | { error: string }
  | { ok: true; payouts: Payout[] };

export async function listPayouts(
  ctx: PayoutContext,
  state: PayoutListState,
): Promise<ListPayoutsResult> {
  const c = client(ctx);
  try {
    const [pending, completed] = await Promise.all([
      state === "completed" ? Promise.resolve([]) : c.listPendingPayouts(),
      state === "pending" ? Promise.resolve([]) : c.listCompletedPayouts(),
    ]);
    return { ok: true, payouts: [...pending, ...completed] };
  } catch (e) {
    console.error("[payout] listPayouts failed", logSafe(state), e);
    return { error: toMessage(e, err(ctx, "statusFailed")) };
  }
}

export type PayoutDetailResult =
  | { error: string }
  | {
      ok: true;
      payout: Payout;
      liveStatus: PayoutStatus;
      /** Ponto signing link — only while `payment-pending`. */
      signingUrl: string | null;
      feeTransferPending: boolean;
      feeTransferTxHash: string | null;
    };

/**
 * Totals + live lifecycle for one payout. `redirectUrl` (an https URL Ponto
 * sends the operator back to after signing) is what makes CP mint the signing
 * link, so pass it whenever the caller wants to surface one.
 */
export async function getPayoutDetail(
  ctx: PayoutContext,
  payoutId: string,
  opts?: { redirectUrl?: string },
): Promise<PayoutDetailResult> {
  const c = client(ctx);
  let payout: Payout;
  try {
    payout = await c.getPayout(payoutId);
  } catch (e) {
    console.error("[payout] getPayout failed", logSafe(payoutId), e);
    return { error: toMessage(e, err(ctx, "payoutNotFound")) };
  }

  // A status read that fails shouldn't lose the totals we already have — fall
  // back to the stored status the detail endpoint carries.
  let live: PayoutStatusDetail | null = null;
  try {
    live = await c.getPayoutStatus(payoutId, opts);
  } catch (e) {
    console.warn("[payout] getPayoutStatus (detail) failed", logSafe(payoutId), e);
  }

  return {
    ok: true,
    payout,
    liveStatus: live?.status ?? payout.status,
    signingUrl: live?.signingUrl ?? null,
    feeTransferPending: live?.feeTransferPending ?? payout.feeTransferPending,
    feeTransferTxHash: live?.feeTransferTxHash ?? payout.feeTransferTxHash,
  };
}

// =============================================================================
// Orders
// =============================================================================

const ORDERS_PAGE_LIMIT = 50; // CP caps the orders endpoint at 50
const MAX_ORDER_PAGES = 40; // safety cap → up to 2000 orders

export type AllPayoutOrders = {
  orders: PayoutOrder[];
  placeAccountAddress: string | null;
  truncated: boolean;
};

/**
 * Every order in a payout, paged to completion. Takes the CP client rather
 * than a context so the page loaders (which key their `cache()` on primitive
 * fund fields) can reuse it. Throws — callers decide how to degrade.
 */
export async function loadAllPayoutOrders(
  c: CitizenPayClient,
  payoutId: string,
): Promise<AllPayoutOrders> {
  const orders: PayoutOrder[] = [];
  let placeAccountAddress: string | null = null;
  let offset = 0;
  let truncated = false;
  for (let i = 0; i < MAX_ORDER_PAGES; i++) {
    const page = await c.getPayoutOrders(payoutId, {
      limit: ORDERS_PAGE_LIMIT,
      offset,
    });
    orders.push(...page.orders);
    placeAccountAddress = page.placeAccountAddress ?? placeAccountAddress;
    offset += page.orders.length;
    if (page.orders.length < ORDERS_PAGE_LIMIT) break;
    if (i === MAX_ORDER_PAGES - 1) truncated = true;
  }
  return { orders, placeAccountAddress, truncated };
}

export type ClassifiedOrder = PayoutOrder & {
  /** "confirmed" once its settlement hash resolves to a mined, non-reverted tx. */
  verification: "confirmed" | "unconfirmed";
};

export type ClassifyOrdersResult =
  | { error: string }
  | {
      ok: true;
      confirmed: ClassifiedOrder[];
      issues: ClassifiedOrder[];
      placeAccountAddress: string | null;
      truncated: boolean;
    };

/**
 * The dashboard's Confirmed / Issues split, server-side. An order is confirmed
 * when its status is settleable on-chain, it carries a settlement hash, and
 * that hash has a successful receipt. Everything else is an issue to fix.
 * Once the payout leaves `pending` the orders are locked in — no verification
 * runs and they all read as confirmed, same as the detail page.
 */
export async function classifyPayoutOrders(
  ctx: PayoutContext,
  payoutId: string,
  opts?: { settled?: boolean },
): Promise<ClassifyOrdersResult> {
  let loaded: AllPayoutOrders;
  try {
    loaded = await loadAllPayoutOrders(client(ctx), payoutId);
  } catch (e) {
    console.error("[payout] loadAllPayoutOrders failed", logSafe(payoutId), e);
    return { error: toMessage(e, err(ctx, "ordersFailed")) };
  }

  const settled = opts?.settled ?? false;
  const chainId = ctx.fund.tokenChainId;
  const checkable = settled
    ? []
    : loaded.orders.filter((o) => isConfirmableOrderStatus(o.status) && !!o.txHash);

  let receipts = new Map<string, TxReceipt>();
  if (checkable.length > 0) {
    try {
      receipts = await resolveOrderReceipts({
        chainId,
        hashes: checkable.map((o) => o.txHash as string),
      });
    } catch (e) {
      // A receipt lookup failure means "unverified", not "no orders" — the
      // orders still come back, just all in Issues.
      console.warn("[payout] resolveOrderReceipts failed", logSafe(payoutId), e);
    }
  }

  const confirmed: ClassifiedOrder[] = [];
  const issues: ClassifiedOrder[] = [];
  for (const order of loaded.orders) {
    const ok =
      settled ||
      (isConfirmableOrderStatus(order.status) &&
        !!order.txHash &&
        receipts.get(order.txHash)?.status === "success");
    const classified: ClassifiedOrder = {
      ...order,
      verification: ok ? "confirmed" : "unconfirmed",
    };
    (ok ? confirmed : issues).push(classified);
  }

  return {
    ok: true,
    confirmed,
    issues,
    placeAccountAddress: loaded.placeAccountAddress,
    truncated: loaded.truncated,
  };
}

// =============================================================================
// Order reconciliation — fix unsettled orders, then tell CP
// =============================================================================
// CP does NOT mint/burn. When a pending payout has an order with no settled
// on-chain tx, we fix it with the fund's own minter wallet, mirroring a real
// payment: the payer is debited the full `total`, the place is credited the
// `net` (total − fee), and the treasury keeps the fee.
//   - payer account     → burn `total` from the payer, then mint `net` to the place;
//   - no payer account  → mint `net` to the place (nothing to burn).
// We then POST the resulting mint tx hash back so CP re-runs its confirmation
// lifecycle.

export type FixOrderResult = { error: string } | { ok: true; txHash: string };

export async function fixOrder(
  ctx: PayoutContext,
  input: {
    payoutId: string;
    orderId: number;
    account: string | null; // payer; null ⇒ mint-only
    placeAccount: string | null; // mint destination
    total: string; // EUR decimal — burned from the payer
    net: string; // EUR decimal (total − fee) — minted to the place
    // When set, the order is already settled on-chain: skip the burn/mint and
    // just record this operator-supplied hash on the order. No place account or
    // payer balance is needed in this mode.
    txHash?: string | null;
  },
): Promise<FixOrderResult> {
  // Manual reconciliation: record an existing settlement hash without moving
  // any tokens. Re-validate the shape the client checked (don't trust it).
  const manualHash = input.txHash?.trim();
  if (manualHash) {
    if (!TX_HASH.test(manualHash)) return { error: err(ctx, "txHashInvalid") };
    try {
      await client(ctx).recordOrderTxHash(
        input.payoutId,
        input.orderId,
        manualHash,
      );
    } catch (e) {
      // Coerce the request-derived id to a number before logging so it can't
      // carry injected newlines into the log (CodeQL js/log-injection).
      console.error(
        "[payout] recordOrderTxHash (manual) failed",
        Number(input.orderId),
        e,
      );
      return { error: toMessage(e, err(ctx, "recordFailed")) };
    }
    revalidatePath(`/payments/payouts/${input.payoutId}`);
    return { ok: true, txHash: manualHash };
  }

  if (!input.placeAccount) return { error: err(ctx, "noPlaceAccount") };

  const direct = { fund: ctx.fund, userId: ctx.userId, t: ctx.t };

  // Burn the full total from the payer first (when there is one), then credit
  // the place its net. The fee is the difference, retained by the treasury.
  // A mint failure after a successful burn is surfaced with the hash so the
  // operator can recover.
  if (input.account) {
    const burn = await burnDirect(
      direct,
      { from: input.account, amount: input.total },
      { trigger: ANNOTATION_TRIGGERS.orderSettlementBurn },
    );
    if ("error" in burn) return { error: burn.error };
  }

  const mint = await mintDirect(
    direct,
    { to: input.placeAccount, amount: input.net },
    { trigger: ANNOTATION_TRIGGERS.orderSettlementMint },
  );
  if ("error" in mint) return { error: mint.error };

  // Record the mint hash so CP confirms it. If this fails the funds have
  // already moved — surface the hash so the operator doesn't re-mint.
  try {
    await client(ctx).recordOrderTxHash(
      input.payoutId,
      input.orderId,
      mint.txHash,
    );
  } catch (e) {
    console.error("[payout] recordOrderTxHash failed", Number(input.orderId), e);
    return { error: `${toMessage(e, err(ctx, "recordFailed"))} (tx ${mint.txHash})` };
  }

  revalidatePath(`/payments/payouts/${input.payoutId}`);
  return { ok: true, txHash: mint.txHash };
}

export type ArchiveOrderResult =
  | { error: string }
  | { ok: true; payout: ArchivedPayout };

export async function archiveOrder(
  ctx: PayoutContext,
  input: { payoutId: string; orderId: number },
): Promise<ArchiveOrderResult> {
  try {
    const payout = await client(ctx).archiveOrder(input.payoutId, input.orderId);
    revalidatePath(`/payments/payouts/${input.payoutId}`);
    return { ok: true, payout };
  } catch (e) {
    console.error("[payout] archiveOrder failed", Number(input.orderId), e);
    return { error: toMessage(e, err(ctx, "archiveFailed")) };
  }
}

// Archive a batch of orders. Best-effort: every order is attempted and reported
// per-order, one failure never aborts the rest. Revalidates once at the end.
export async function archiveOrders(
  ctx: PayoutContext,
  input: { payoutId: string; orderIds: number[] },
): Promise<ArchiveOrdersItemResult[]> {
  const c = client(ctx);
  const results: ArchiveOrdersItemResult[] = [];
  for (const orderId of input.orderIds) {
    try {
      await c.archiveOrder(input.payoutId, orderId);
      results.push({ orderId, ok: true });
    } catch (e) {
      console.error("[payout] archiveOrders: archive failed", Number(orderId), e);
      results.push({
        orderId,
        ok: false,
        error: toMessage(e, err(ctx, "archiveFailed")),
      });
    }
  }
  revalidatePath(`/payments/payouts/${input.payoutId}`);
  return results;
}

// Auto-match a batch of orders against their payers' on-chain transfers and
// record the settling hash where exactly one matches (amount = order total,
// same UTC calendar day). No tokens are minted or burned — this only records an
// already-existing on-chain hash. Bank-paid orders (no payer account) come back
// "noaccount" and stay in Issues.
export async function autoMatchPayerTransfers(
  ctx: PayoutContext,
  input: {
    payoutId: string;
    orders: {
      orderId: number;
      account: string | null;
      total: string;
      completedAt: string | null;
    }[];
  },
): Promise<AutoMatchResult[]> {
  const { fund } = ctx;

  // No token config → we can't read on-chain transfers at all.
  if (!fund.tokenAddress) {
    return input.orders.map((o) => ({
      orderId: o.orderId,
      status: "unavailable" as const,
    }));
  }
  const tokenAddress = fund.tokenAddress;
  const chainId = fund.tokenChainId;
  const c = client(ctx);

  // Load each distinct payer's transfers at most once — a payer with several
  // orders in the same payout shouldn't trigger a fetch per order.
  const transfersByAccount = new Map<string, MatchTransfer[]>();
  async function loadTransfers(account: string): Promise<MatchTransfer[]> {
    const cached = transfersByAccount.get(account);
    if (cached) return cached;
    const { transfers } = await listTransfersForAccount({
      chainId,
      contractAddress: tokenAddress,
      account,
      pageSize: 100,
    });
    const normalised: MatchTransfer[] = transfers.map((tx) => ({
      hash: tx.hash,
      amount: formatTokenAmount(tx.rawValue, fund.tokenDecimals),
      date: tx.blockTimestamp,
      direction: tx.from.toLowerCase() === account ? "out" : "in",
    }));
    transfersByAccount.set(account, normalised);
    return normalised;
  }

  const results: AutoMatchResult[] = [];
  for (const order of input.orders) {
    if (!order.account) {
      results.push({ orderId: order.orderId, status: "noaccount" });
      continue;
    }
    const account = order.account.toLowerCase();
    try {
      const transfers = await loadTransfers(account);
      const match = matchPayerTransfer(
        { total: order.total, completedAt: order.completedAt },
        transfers,
      );
      if (match.status !== "fixed") {
        results.push({ orderId: order.orderId, status: match.status });
        continue;
      }
      // Exactly one settling transfer — record its hash, same path as the
      // per-order manual fix. Nothing moves on-chain.
      await c.recordOrderTxHash(input.payoutId, order.orderId, match.txHash!);
      results.push({
        orderId: order.orderId,
        status: "fixed",
        txHash: match.txHash,
      });
    } catch (e) {
      console.error(
        "[payout] autoMatchPayerTransfers failed",
        Number(order.orderId),
        e,
      );
      results.push({ orderId: order.orderId, status: "error" });
    }
  }

  revalidatePath(`/payments/payouts/${input.payoutId}`);
  return results;
}

// -----------------------------------------------------------------------------
// Terminal orders — auto-match the place's own mints / burns
// -----------------------------------------------------------------------------
// Terminal orders have no payer account; they settle by minting the order `net`
// to the place. When those mints were submitted through a different bundler our
// bundler can't resolve the recorded UserOp hash, so the order shows unconfirmed
// even though the tokens landed. We find the real transfer on the place account
// (exact amount + nearest timestamp, consumed once) and record its real tx hash
// — which also self-heals verification (a real tx resolves via the chain RPC).

// How close (ms) a mint's block time must be to the order's completion to count
// as its settlement. Orders and mints are matched on the same calendar day; we
// walk the place's transfers back a day past the earliest order to be safe.
const PLACE_MINT_LOOKBACK_MS = 24 * 60 * 60 * 1000;
// Bound the transfer walk so a very active place can't run the plan unbounded.
const PLACE_MINT_MAX_PAGES = 50;
const PLACE_MINT_PAGE_SIZE = 100;

// Diagnostic surfaced to the client so a "nothing matched" run can be inspected
// from the browser console without digging Vercel logs.
export type PlanPlaceMintsDebug = {
  placeAccount: string | null;
  hasTokenConfig: boolean;
  tokenDecimals: number | null;
  orders: number;
  incoming: number;
  matched: number;
  truncated: boolean;
  sampleNets: string[];
  sampleAmounts: { amount: string; date: string | null }[];
};

export type PlanPlaceMintsResult =
  | { status: "unavailable"; debug: PlanPlaceMintsDebug }
  | {
      status: "ok";
      matched: { orderId: number; txHash: string }[];
      unmatched: number[];
      // The transfer walk hit its page cap before covering the whole range, so
      // some orders may be unmatched only because their transfer wasn't loaded.
      truncated: boolean;
      debug: PlanPlaceMintsDebug;
    };

// Shared place-side transfer load for both plans. Resolves the place account
// (CP re-fetch + the caller-supplied fallback), bounds the query to the block
// range covering the orders' days, and walks one direction of the place's
// transfers in that window. `in` gathers mints (paid terminal + `refunded`
// orders); `out` gathers burns (`refund` orders).
async function loadPlaceTransfersForPlan(
  ctx: PayoutContext,
  input: {
    payoutId: string;
    placeAccount?: string | null;
    anchors: (string | null)[];
    direction: "in" | "out";
  },
): Promise<{
  place: string | null;
  hasTokenConfig: boolean;
  transfers: MatchTransfer[];
  truncated: boolean;
}> {
  const { fund } = ctx;
  if (!fund.tokenAddress) {
    return { place: null, hasTokenConfig: false, transfers: [], truncated: false };
  }
  const tokenAddress = fund.tokenAddress;
  const chainId = fund.tokenChainId;
  const c = client(ctx);

  // The place account rides on the orders-page envelope (same read burnPayout /
  // fixOrder use).
  let placeAccount: string | null = null;
  try {
    const page = await c.getPayoutOrders(input.payoutId, { limit: 1 });
    placeAccount = page.placeAccountAddress ?? null;
  } catch (e) {
    console.error("[payout] planPlaceMatches: resolve place failed", e);
  }
  // Fall back to the account the caller already resolved (the per-call read
  // above is occasionally empty). Both originate server-side from CP.
  if (!placeAccount && input.placeAccount) {
    placeAccount = input.placeAccount;
  }
  if (!placeAccount) {
    return { place: null, hasTokenConfig: true, transfers: [], truncated: false };
  }
  const place = placeAccount.toLowerCase();

  const orderTimes = input.anchors
    .map((a) => (a ? Date.parse(a) : NaN))
    .filter((t) => !Number.isNaN(t));
  const minTime = orderTimes.length ? Math.min(...orderTimes) : Date.now();
  const maxTime = orderTimes.length ? Math.max(...orderTimes) : Date.now();

  const transfers: MatchTransfer[] = [];
  let truncated = false;
  try {
    // Cover the full days of the earliest/latest order, with a lookback margin.
    const range = await estimateBlockRange({
      chainId,
      fromMs: minTime - PLACE_MINT_LOOKBACK_MS,
      toMs: maxTime + PLACE_MINT_LOOKBACK_MS,
    });
    if (!range) throw new Error("could not estimate block range");

    let cursor: string | null = null;
    let pages = 0;
    do {
      const { transfers: page, nextPageKey }: ListTransfersResult =
        input.direction === "in"
          ? await listIncomingTransfersInRange({
              chainId,
              contractAddress: tokenAddress,
              toAccount: place,
              fromBlock: range.fromBlock,
              toBlock: range.toBlock,
              pageSize: PLACE_MINT_PAGE_SIZE,
              cursor,
            })
          : await listOutgoingTransfersInRange({
              chainId,
              contractAddress: tokenAddress,
              fromAccount: place,
              fromBlock: range.fromBlock,
              toBlock: range.toBlock,
              pageSize: PLACE_MINT_PAGE_SIZE,
              cursor,
            });
      for (const tx of page) {
        // Prefer Alchemy's decimal `value` (computed with the token's real
        // on-chain decimals) so a mis-cached fund.tokenDecimals can't scale the
        // amount wrong; fall back to formatting the raw value only if absent.
        transfers.push({
          hash: tx.hash,
          amount:
            tx.value != null
              ? String(tx.value)
              : formatTokenAmount(tx.rawValue, fund.tokenDecimals),
          date: tx.blockTimestamp,
          direction: input.direction,
        });
      }
      cursor = nextPageKey;
      pages += 1;
      if (pages >= PLACE_MINT_MAX_PAGES) {
        truncated = cursor != null;
        break;
      }
    } while (cursor != null);
  } catch (e) {
    console.error("[payout] planPlaceMatches: transfer load failed", e);
    // Match on whatever we gathered rather than failing the whole batch.
    truncated = true;
  }

  return { place, hasTokenConfig: true, transfers, truncated };
}

// Terminal (paid, no-payer) and `refunded` orders: match each order's `net`
// against an incoming mint on the place account.
export async function planPlaceMintMatches(
  ctx: PayoutContext,
  input: {
    payoutId: string;
    placeAccount?: string | null;
    orders: {
      orderId: number;
      net: string;
      createdAt: string | null;
      completedAt: string | null;
    }[];
  },
): Promise<PlanPlaceMintsResult> {
  const sampleNets = input.orders.slice(0, 5).map((o) => o.net);

  const load = await loadPlaceTransfersForPlan(ctx, {
    payoutId: input.payoutId,
    placeAccount: input.placeAccount,
    anchors: input.orders.map((o) => o.createdAt ?? o.completedAt),
    direction: "in",
  });
  if (!load.hasTokenConfig || load.place == null) {
    return {
      status: "unavailable",
      debug: {
        placeAccount: load.place,
        hasTokenConfig: load.hasTokenConfig,
        tokenDecimals: ctx.fund.tokenDecimals,
        orders: input.orders.length,
        incoming: 0,
        matched: 0,
        truncated: false,
        sampleNets,
        sampleAmounts: [],
      },
    };
  }

  const { matched, unmatched } = assignPlaceMints(input.orders, load.transfers);
  const debug: PlanPlaceMintsDebug = {
    placeAccount: load.place,
    hasTokenConfig: true,
    tokenDecimals: ctx.fund.tokenDecimals,
    orders: input.orders.length,
    incoming: load.transfers.length,
    matched: matched.length,
    truncated: load.truncated,
    sampleNets,
    sampleAmounts: load.transfers
      .slice(0, 5)
      .map((t) => ({ amount: t.amount, date: t.date })),
  };
  console.log("[payout] planPlaceMint diag", logSafe(debug));
  return { status: "ok", matched, unmatched, truncated: load.truncated, debug };
}

// `refund` orders: match each order's `total` (fees included) against an
// outgoing burn from the place account. Mirror of planPlaceMintMatches,
// walking outgoing transfers instead of incoming.
export async function planPlaceBurnMatches(
  ctx: PayoutContext,
  input: {
    payoutId: string;
    placeAccount?: string | null;
    orders: {
      orderId: number;
      total: string;
      createdAt: string | null;
      completedAt: string | null;
    }[];
  },
): Promise<PlanPlaceMintsResult> {
  const sampleNets = input.orders.slice(0, 5).map((o) => o.total);

  const load = await loadPlaceTransfersForPlan(ctx, {
    payoutId: input.payoutId,
    placeAccount: input.placeAccount,
    anchors: input.orders.map((o) => o.createdAt ?? o.completedAt),
    direction: "out",
  });
  if (!load.hasTokenConfig || load.place == null) {
    return {
      status: "unavailable",
      debug: {
        placeAccount: load.place,
        hasTokenConfig: load.hasTokenConfig,
        tokenDecimals: ctx.fund.tokenDecimals,
        orders: input.orders.length,
        incoming: 0,
        matched: 0,
        truncated: false,
        sampleNets,
        sampleAmounts: [],
      },
    };
  }

  const { matched, unmatched } = assignPlaceBurns(input.orders, load.transfers);
  const debug: PlanPlaceMintsDebug = {
    placeAccount: load.place,
    hasTokenConfig: true,
    tokenDecimals: ctx.fund.tokenDecimals,
    orders: input.orders.length,
    // `incoming` counts the loaded pool regardless of direction (here: burns).
    incoming: load.transfers.length,
    matched: matched.length,
    truncated: load.truncated,
    sampleNets,
    sampleAmounts: load.transfers
      .slice(0, 5)
      .map((t) => ({ amount: t.amount, date: t.date })),
  };
  console.log("[payout] planPlaceBurn diag", logSafe(debug));
  return { status: "ok", matched, unmatched, truncated: load.truncated, debug };
}

// Bulk-record already-resolved (orderId, txHash) pairs. Best-effort, per-order
// results, one revalidate at the end. The hash is re-checked here (don't trust
// the caller) before it hits CP.
export async function recordOrderHashes(
  ctx: PayoutContext,
  input: { payoutId: string; entries: { orderId: number; txHash: string }[] },
): Promise<ArchiveOrdersItemResult[]> {
  const c = client(ctx);
  const results: ArchiveOrdersItemResult[] = [];
  for (const entry of input.entries) {
    const hash = entry.txHash.trim();
    if (!TX_HASH.test(hash)) {
      results.push({
        orderId: entry.orderId,
        ok: false,
        error: err(ctx, "txHashInvalid"),
      });
      continue;
    }
    try {
      await c.recordOrderTxHash(input.payoutId, entry.orderId, hash);
      results.push({ orderId: entry.orderId, ok: true });
    } catch (e) {
      console.error("[payout] recordOrderHashes failed", Number(entry.orderId), e);
      results.push({
        orderId: entry.orderId,
        ok: false,
        error: toMessage(e, err(ctx, "recordFailed")),
      });
    }
  }
  revalidatePath(`/payments/payouts/${input.payoutId}`);
  return results;
}

// -----------------------------------------------------------------------------
// One-shot auto-match over a whole batch
// -----------------------------------------------------------------------------
// The dashboard drives the three matchers from the client so it can render a
// progress bar; a non-interactive caller (MCP) wants one call. Same routing
// (services/payout/match.ts::autoMatchRoute) and the same consume-once place
// plans, run server-side end to end.

export type AutoMatchOrderInput = {
  id: number;
  status: string;
  account: string | null;
  total: string;
  net: string;
  completedAt: string | null;
  createdAt: string | null;
};

export type AutoMatchBatchResult = {
  fixed: { orderId: number; txHash: string }[];
  /** Orders left in Issues, with why: nomatch | ambiguous | error | unavailable | truncated. */
  unresolved: { orderId: number; reason: string }[];
};

export async function autoMatchOrders(
  ctx: PayoutContext,
  input: {
    payoutId: string;
    orders: AutoMatchOrderInput[];
    placeAccount?: string | null;
  },
): Promise<AutoMatchBatchResult> {
  const fixed: { orderId: number; txHash: string }[] = [];
  const unresolved: { orderId: number; reason: string }[] = [];

  const payerOrders = input.orders.filter((o) => autoMatchRoute(o) === "payer");
  const mintOrders = input.orders.filter((o) => autoMatchRoute(o) === "place-mint");
  const burnOrders = input.orders.filter((o) => autoMatchRoute(o) === "place-burn");

  if (payerOrders.length > 0) {
    const results = await autoMatchPayerTransfers(ctx, {
      payoutId: input.payoutId,
      orders: payerOrders.map((o) => ({
        orderId: o.id,
        account: o.account,
        total: o.total,
        completedAt: o.completedAt,
      })),
    });
    for (const r of results) {
      if (r.status === "fixed" && r.txHash) {
        fixed.push({ orderId: r.orderId, txHash: r.txHash });
      } else {
        unresolved.push({ orderId: r.orderId, reason: r.status });
      }
    }
  }

  // Record the pairs a place plan resolved and roll the outcome up. Shared by
  // the mint and burn plans, which only differ in the direction they walk.
  const applyPlan = async (plan: PlanPlaceMintsResult, batch: AutoMatchOrderInput[]) => {
    if (plan.status !== "ok") {
      for (const o of batch) unresolved.push({ orderId: o.id, reason: "unavailable" });
      return;
    }
    // Unmatched: attribute to "truncated" when the walk was capped (their
    // transfer may just not have been loaded), otherwise a genuine no-match.
    for (const orderId of plan.unmatched) {
      unresolved.push({ orderId, reason: plan.truncated ? "truncated" : "nomatch" });
    }
    if (plan.matched.length === 0) return;
    const results = await recordOrderHashes(ctx, {
      payoutId: input.payoutId,
      entries: plan.matched,
    });
    const hashById = new Map(plan.matched.map((m) => [m.orderId, m.txHash]));
    for (const r of results) {
      if (r.ok) {
        fixed.push({ orderId: r.orderId, txHash: hashById.get(r.orderId) ?? "" });
      } else {
        unresolved.push({ orderId: r.orderId, reason: "error" });
      }
    }
  };

  if (mintOrders.length > 0) {
    const plan = await planPlaceMintMatches(ctx, {
      payoutId: input.payoutId,
      placeAccount: input.placeAccount,
      orders: mintOrders.map((o) => ({
        orderId: o.id,
        net: o.net,
        createdAt: o.createdAt,
        completedAt: o.completedAt,
      })),
    });
    await applyPlan(plan, mintOrders);
  }

  if (burnOrders.length > 0) {
    const plan = await planPlaceBurnMatches(ctx, {
      payoutId: input.payoutId,
      placeAccount: input.placeAccount,
      orders: burnOrders.map((o) => ({
        orderId: o.id,
        total: o.total,
        createdAt: o.createdAt,
        completedAt: o.completedAt,
      })),
    });
    await applyPlan(plan, burnOrders);
  }

  return { fixed, unresolved };
}

// =============================================================================
// Manual order creation — add an off-CP amount to a pending payout
// =============================================================================

export type CreatePayoutOrderResult =
  | { error: string }
  // Order created AND its net minted to the place (txHash recorded).
  | { ok: true; order: PayoutOrder; payout: ArchivedPayout; txHash: string }
  // Order created but the automatic mint failed — it lands in "Issues" for a
  // manual Fix. `mintError` explains why so the operator isn't left guessing.
  | { ok: true; order: PayoutOrder; payout: ArchivedPayout; mintError: string };

export async function createPayoutOrder(
  ctx: PayoutContext,
  input: {
    payoutId: string;
    total: string;
    fees: string;
    description: string | null;
  },
): Promise<CreatePayoutOrderResult> {
  const parsed = CreatePayoutOrderSchema.safeParse(input);
  if (!parsed.success) {
    return {
      error: ctx.t(parsed.error.issues[0]?.message ?? `${ERR}.createOrderFailed`),
    };
  }

  const c = client(ctx);

  // 1. Create the order (rolls its amount into the payout totals). A failure
  //    here is safe to retry — nothing has been created yet.
  let order: PayoutOrder;
  let payout: ArchivedPayout;
  try {
    ({ order, payout } = await c.createPayoutOrder(parsed.data.payoutId, {
      total: parsed.data.total,
      fees: parsed.data.fees,
      description: parsed.data.description?.trim() || null,
    }));
  } catch (e) {
    console.error("[payout] createPayoutOrder failed", logSafe(input), e);
    return { error: toMessage(e, err(ctx, "createOrderFailed")) };
  }

  // The order now exists. Reconcile it the same way the per-order "Fix" does:
  // mint the net to the place and record the hash. A manual order has no payer
  // account, so this is mint-only (no burn). Past this point we never return a
  // bare { error } — the order is created, so any mint failure comes back as
  // { ok, mintError } to avoid duplicate creates.
  revalidatePath(`/payments/payouts/${parsed.data.payoutId}`);

  let placeAccount: string | null = null;
  try {
    const page = await c.getPayoutOrders(parsed.data.payoutId, {
      limit: 1,
      offset: 0,
    });
    placeAccount = page.placeAccountAddress ?? null;
  } catch (e) {
    console.error("[payout] resolve place account failed", logSafe(input), e);
  }
  if (!placeAccount) {
    return { ok: true, order, payout, mintError: err(ctx, "noPlaceAccount") };
  }

  const mint = await mintDirect(
    { fund: ctx.fund, userId: ctx.userId, t: ctx.t },
    { to: placeAccount, amount: order.net },
    { trigger: ANNOTATION_TRIGGERS.orderSettlementMint },
  );
  if ("error" in mint) {
    return { ok: true, order, payout, mintError: mint.error };
  }

  // Record the mint hash so the order reads as confirmed. If this fails the
  // tokens have already moved — surface the hash so it isn't re-minted.
  try {
    await c.recordOrderTxHash(parsed.data.payoutId, order.id, mint.txHash);
  } catch (e) {
    console.error("[payout] recordOrderTxHash failed", Number(order.id), e);
    return {
      ok: true,
      order,
      payout,
      mintError: `${toMessage(e, err(ctx, "recordFailed"))} (tx ${mint.txHash})`,
    };
  }

  revalidatePath(`/payments/payouts/${parsed.data.payoutId}`);
  return { ok: true, order, payout, txHash: mint.txHash };
}

// =============================================================================
// Adding existing orders
// =============================================================================

export type AddOrdersOutcome =
  | { error: string }
  // 422 — one or more selected orders went stale (cancelled / claimed by
  // another payout). Nothing was added; `rejected` says which and why.
  | { error: string; rejected: { id: number; reason: string }[] }
  | { ok: true; assigned: number; payout: ArchivedPayout };

// Pull the CP-supplied `rejected` list off a 422 body so the caller can show
// which ids failed. Defensive — CP's shape is `{ error, rejected: [{ id, reason }] }`
// but we tolerate a missing/misshapen list rather than throwing while erroring.
function rejectedFromError(e: unknown): { id: number; reason: string }[] {
  if (!(e instanceof CitizenPayApiError) || e.status !== 422) return [];
  const body = e.body;
  if (!body || typeof body !== "object" || !("rejected" in body)) return [];
  const raw = (body as { rejected: unknown }).rejected;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r) => {
    if (!r || typeof r !== "object") return [];
    const id = (r as { id?: unknown }).id;
    const reason = (r as { reason?: unknown }).reason;
    return typeof id === "number"
      ? [{ id, reason: typeof reason === "string" ? reason : "" }]
      : [];
  });
}

export async function addOrders(
  ctx: PayoutContext,
  input: { payoutId: string; orderIds: number[] },
): Promise<AddOrdersOutcome> {
  const parsed = AddOrdersSchema.safeParse(input);
  if (!parsed.success) {
    return { error: ctx.t(parsed.error.issues[0]?.message ?? `${ERR}.addOrdersFailed`) };
  }

  try {
    const res = await client(ctx).addOrdersToPayout(
      parsed.data.payoutId,
      parsed.data.orderIds,
    );
    revalidatePath("/payments");
    revalidatePath(`/payments/payouts/${parsed.data.payoutId}`);
    return { ok: true, assigned: res.assigned, payout: res.payout };
  } catch (e) {
    // 422 is the stale-selection case (all-or-nothing): surface the per-order
    // reasons so the caller can drop them and re-preview.
    const rejected = rejectedFromError(e);
    if (rejected.length > 0) {
      return { error: err(ctx, "addOrdersRejected"), rejected };
    }
    console.error("[payout] addOrders failed", logSafe(input), e);
    return { error: toMessage(e, err(ctx, "addOrdersFailed")) };
  }
}

// =============================================================================
// Settlement — pay the merchant, then burn the tokens
// =============================================================================

export type CreatePayoutPaymentOutcome =
  | { error: string }
  | {
      ok: true;
      /** True when CP already had a live payment — no fresh link was minted. */
      alreadyCreated: boolean;
      /** The bank's signing link the operator must open to authorise the SEPA transfer. */
      signingUrl: string | null;
      paymentId: string | null;
    };

/**
 * Step 1 of settlement: ask CP to create the SEPA payment. The signing URL is
 * re-read from `/status` afterwards because that read is canonical and survives
 * reloads (the create response only carries it the first time).
 */
export async function createPayoutPayment(
  ctx: PayoutContext,
  payoutId: string,
  opts?: { redirectUrl?: string },
): Promise<CreatePayoutPaymentOutcome> {
  const c = client(ctx);
  let created: Awaited<ReturnType<CitizenPayClient["createPayoutPayment"]>>;
  try {
    created = await c.createPayoutPayment(payoutId, opts);
  } catch (e) {
    console.error("[payout] createPayoutPayment failed", logSafe(payoutId), e);
    return { error: toMessage(e, err(ctx, "payFailed")) };
  }

  let signingUrl = created.alreadyCreated ? null : created.signingUrl;
  try {
    const live = await c.getPayoutStatus(payoutId, opts);
    signingUrl = live.signingUrl ?? signingUrl;
  } catch (e) {
    console.warn("[payout] signing-url re-read failed", logSafe(payoutId), e);
  }

  // The detail page re-reads status (now payment-pending) + signing URL.
  revalidatePath(`/payments/payouts/${payoutId}`);
  return {
    ok: true,
    alreadyCreated: created.alreadyCreated,
    signingUrl,
    paymentId: created.alreadyCreated ? null : created.paymentId,
  };
}

export type BurnPayoutResult =
  | { error: string }
  | {
      ok: true;
      txHash: string;
      // Sweep outcome. The burn itself succeeded; the sweep of the retained cut
      // (fees + manualDeduction) is decoupled. `feeTransferTxHash` is set when
      // it ran inline; `feeTransferPending` is true when it still needs running
      // (retry via `feeTransfer`), with the reason in `feeTransferError`.
      feeAmount?: string | null;
      feeTransferTxHash?: string | null;
      feeTransferPending?: boolean;
      feeTransferError?: string | null;
    };

/**
 * Burn step. CP no longer burns server-side — we burn the place's tokens (the
 * payout `net`) with the fund's minter wallet, then report the hash so CP marks
 * the payout `burnt`. Only valid while the payout is `pending`; live status is
 * re-checked first so a duplicate submit can't double-burn. IRREVERSIBLE.
 */
export async function burnPayout(
  ctx: PayoutContext,
  payoutId: string,
): Promise<BurnPayoutResult> {
  const { fund } = ctx;
  try {
    const c = client(ctx);

    // Idempotency guard: CP flips the payout to `burnt` the instant it records
    // our hash, so re-checking live status here means a stale/duplicate submit
    // can't double-burn.
    const { status } = await c.getPayoutStatus(payoutId);
    if (status !== "pending") return { error: err(ctx, "notBurnable") };

    // Amount = the payout `net` (total − fees − manualDeduction): the tokens
    // the place holds for this payout. Read straight from the detail endpoint.
    let payout;
    try {
      payout = await c.getPayout(payoutId);
    } catch {
      return { error: err(ctx, "payoutNotFound") };
    }

    // Source = the place's wallet (each order's net was minted there). It rides
    // on the orders-page envelope — one row is enough to read it.
    const ordersPage = await c.getPayoutOrders(payoutId, { limit: 1 });
    const placeAccount = ordersPage.placeAccountAddress;
    if (!placeAccount) return { error: err(ctx, "noPlaceAccount") };

    // Burn only the `net` on-chain with our minter (records a TokenOperation).
    // The place account also holds the retained cut (fees + manualDeduction);
    // CP sweeps that to our minter account when we pass `destination` below.
    const burn = await burnDirect(
      { fund, userId: ctx.userId, t: ctx.t },
      { from: placeAccount, amount: payout.net },
      { trigger: ANNOTATION_TRIGGERS.payoutBurn },
    );
    if ("error" in burn) return { error: burn.error };

    // Report the hash so CP marks the payout burnt, and hand CP the minter
    // smart account as the sweep destination for the retained cut. A non-2xx
    // here means the BURN record failed — the tokens are already gone, so
    // surface the hash and do NOT retry (re-running would burn again). A 2xx
    // means the burn is recorded; the sweep is reported in the body and may be
    // pending (retry via `feeTransfer`) without being a burn failure.
    let report;
    try {
      report = await c.burnPayout(
        payoutId,
        burn.txHash,
        fund.tokenMinterSmartAccountAddress ?? undefined,
      );
    } catch (e) {
      console.error("[payout] reporting burn to CP failed", logSafe(payoutId), e);
      return { error: `${err(ctx, "reportFailed")} (tx ${burn.txHash})` };
    }

    // The burn itself is annotated inside burnDirect (trigger PAYOUT_BURN,
    // acting admin). The fee sweep is CP's own userOp — annotate it here: a
    // userOp's settlement tx hash isn't final until `success` (a retry can
    // change it), so we resolve once now and queue if still pending.
    if (report.feeTransferTxHash) {
      await resolveOrEnqueueAnnotation({
        fundId: fund.id,
        chainId: fund.tokenChainId,
        userOpHash: report.feeTransferTxHash,
        kind: ANNOTATION_TRIGGERS.payoutFee,
        trigger: ANNOTATION_TRIGGERS.payoutFee,
        triggeredByUserId: ctx.userId,
      });
    }

    revalidatePath("/payments");
    revalidatePath(`/payments/payouts/${payoutId}`);
    return {
      ok: true,
      txHash: burn.txHash,
      feeAmount: report.feeAmount,
      feeTransferTxHash: report.feeTransferTxHash,
      feeTransferPending: report.feeTransferPending,
      feeTransferError: report.feeTransferError,
    };
  } catch (e) {
    console.error("[payout] burnPayout failed", logSafe(payoutId), e);
    return { error: toMessage(e, err(ctx, "burnFailed")) };
  }
}

export type FeeTransferOutcome =
  | { error: string }
  | {
      ok: true;
      feeTransferTxHash: string;
      feeAmount: string | null;
      alreadyTransferred: boolean;
    };

/**
 * Run (or retry) just the fee sweep for an already-burned payout — the
 * standalone, idempotent counterpart to the burn's inline sweep. Sweeps to the
 * fund's minter account. Idempotent on CP's side, so a retry after a lost
 * response won't double-transfer.
 */
export async function feeTransfer(
  ctx: PayoutContext,
  payoutId: string,
): Promise<FeeTransferOutcome> {
  const destination = ctx.fund.tokenMinterSmartAccountAddress;
  if (!destination) return { error: err(ctx, "noFeeDestination") };

  try {
    const res = await client(ctx).feeTransfer(payoutId, destination);
    // CP returns a userOp hash — resolve to the real tx hash now if it's
    // already settled, otherwise queue for the cron.
    await resolveOrEnqueueAnnotation({
      fundId: ctx.fund.id,
      chainId: ctx.fund.tokenChainId,
      userOpHash: res.feeTransferTxHash,
      kind: ANNOTATION_TRIGGERS.payoutFee,
      trigger: ANNOTATION_TRIGGERS.payoutFee,
      triggeredByUserId: ctx.userId,
    });
    revalidatePath("/payments");
    revalidatePath(`/payments/payouts/${payoutId}`);
    return {
      ok: true,
      feeTransferTxHash: res.feeTransferTxHash,
      feeAmount: res.feeAmount,
      alreadyTransferred: res.alreadyTransferred,
    };
  } catch (e) {
    // CP surfaces sweep failures as HTTP status with a descriptive message
    // (402 insufficient, 409 not-burnt/in-progress, 422 config, 503 bundler).
    // toMessage forwards that message so the operator sees the real reason.
    console.error("[payout] feeTransfer failed", logSafe(payoutId), e);
    return { error: toMessage(e, err(ctx, "feeTransferFailed")) };
  }
}

// =============================================================================
// Manual deduction (ledger adjustment)
// =============================================================================

export type SetManualDeductionResult =
  | { error: string }
  | { ok: true; payout: PayoutDeduction };

/**
 * Set/clear a payout's manual deduction (+ comment). A pure ledger adjustment
 * on CP's side — it lowers the `net` the merchant is paid, with no on-chain
 * effect. Only mutable while the payout is pending; we pre-check status (and
 * that the deduction can't drive net negative) for a clear message, but CP is
 * the final authority.
 */
export async function setManualDeduction(
  ctx: PayoutContext,
  input: { payoutId: string; amount: string; comment: string | null },
): Promise<SetManualDeductionResult> {
  const parsed = SetManualDeductionSchema.safeParse(input);
  if (!parsed.success) {
    return { error: ctx.t(parsed.error.issues[0]?.message ?? `${ERR}.deductionFailed`) };
  }

  const c = client(ctx);

  // Need the current totals both to validate the bound and (live status) to
  // confirm the payout is still editable.
  let payout;
  try {
    payout = await c.getPayout(parsed.data.payoutId);
  } catch {
    return { error: err(ctx, "payoutNotFound") };
  }

  let status;
  try {
    ({ status } = await c.getPayoutStatus(parsed.data.payoutId));
  } catch (e) {
    console.error("[payout] deduction status read failed", logSafe(input), e);
    return { error: toMessage(e, err(ctx, "statusFailed")) };
  }
  if (status !== "pending") return { error: err(ctx, "deductionNotPending") };

  // A deduction larger than (total − fees) would drive net negative.
  const maxDeduction = Number(payout.totalAmount) - Number(payout.totalFees);
  if (Number(parsed.data.amount) > maxDeduction) {
    return { error: err(ctx, "deductionTooHigh") };
  }

  try {
    const updated = await c.setManualDeduction(parsed.data.payoutId, {
      amount: parsed.data.amount,
      comment: parsed.data.comment?.trim() || null,
    });
    revalidatePath("/payments");
    revalidatePath(`/payments/payouts/${parsed.data.payoutId}`);
    return { ok: true, payout: updated };
  } catch (e) {
    console.error("[payout] setManualDeduction failed", logSafe(input), e);
    return { error: toMessage(e, err(ctx, "deductionFailed")) };
  }
}

/** Clear the deduction + comment, net back to total − fees. Same pending gate. */
export async function clearManualDeduction(
  ctx: PayoutContext,
  payoutId: string,
): Promise<SetManualDeductionResult> {
  const c = client(ctx);

  let status;
  try {
    ({ status } = await c.getPayoutStatus(payoutId));
  } catch (e) {
    console.error("[payout] deduction status read failed", logSafe(payoutId), e);
    return { error: toMessage(e, err(ctx, "statusFailed")) };
  }
  if (status !== "pending") return { error: err(ctx, "deductionNotPending") };

  try {
    const updated = await c.clearManualDeduction(payoutId);
    revalidatePath("/payments");
    revalidatePath(`/payments/payouts/${payoutId}`);
    return { ok: true, payout: updated };
  } catch (e) {
    console.error("[payout] clearManualDeduction failed", logSafe(payoutId), e);
    return { error: toMessage(e, err(ctx, "deductionFailed")) };
  }
}

export type CompletePayoutResult = { error: string } | { ok: true };

/**
 * Admin override: mark a payout complete without burning or paying — for when
 * the treasury settled with the merchant another way. Bypasses settlement and
 * can't be undone.
 */
export async function completePayout(
  ctx: PayoutContext,
  payoutId: string,
): Promise<CompletePayoutResult> {
  try {
    await client(ctx).completePayout(payoutId);
    revalidatePath("/payments");
    revalidatePath(`/payments/payouts/${payoutId}`);
    return { ok: true };
  } catch (e) {
    console.error("[payout] completePayout failed", logSafe(payoutId), e);
    return { error: toMessage(e, err(ctx, "completeFailed")) };
  }
}
