// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { refresh, revalidatePath } from "next/cache";

import { getBalances } from "@/services/alchemy/balances";
import { formatTokenAmount } from "@/services/alchemy/format";
import { listTransfersForAccount } from "@/services/alchemy/transfers";
import { requireFundRole } from "@/services/auth/dal";
import { CitizenPayApiError } from "@/services/citizenpay/api";
import { getCitizenPayClient } from "@/services/citizenpay/client";
import type {
  ArchivedPayout,
  PayoutDeduction,
  PayoutOrder,
  PayoutStatus,
} from "@/services/citizenpay/types";
import { Prisma } from "@/services/db/generated/client";
import { prisma } from "@/services/db/prisma";
import {
  manualBurnDirectAction,
  manualMintDirectAction,
} from "@/services/token-operations/admin-actions";

import { ANNOTATION_TRIGGERS } from "@/services/transaction-annotation/annotate";
import { resolveOrEnqueueAnnotation } from "@/services/transaction-annotation/pending";

import { resolveOrderReceipts, type TxReceiptStatus } from "./receipts";
import {
  CreatePayoutOrderSchema,
  PayoutRangeSchema,
  SetManualDeductionSchema,
  toRfc3339,
} from "./schemas";

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
  if (fund.tokenChainId == null) {
    for (const h of input.hashes) out[h] = "pending";
    return out;
  }
  const map = await resolveOrderReceipts({
    chainId: fund.tokenChainId,
    hashes: input.hashes,
  });
  for (const h of input.hashes) out[h] = map.get(h)?.status ?? "pending";
  return out;
}

// Payout lifecycle, driven from Payments → Payouts.
//   - previewPayoutDraftAction: live count/total for a place + range.
//   - createPayoutAction: materialise a pending payout (claims orders).
//   - createPayoutPaymentAction: ask CP for the SEPA payment + signing URL.
//   - burnPayoutAction: burn the backing tokens once the fiat leg is paid
//     (irreversible — the UI confirms before firing).
//   - getPayoutStatusAction: live status for the settle buttons / polling.
// All go through the per-fund CitizenPay client; the fund (with its
// encrypted API creds) comes from requireFundRole.

// Just kicks off the bank payment. The signing URL is no longer returned
// here — the dashboard reads it from `GET /payouts/{id}/status` (canonical,
// survives reloads), so we only need success/failure + a revalidate.
export type CreatePayoutPaymentResult =
  | { error: string }
  | { ok: true };

export type BurnPayoutResult =
  | { error: string }
  | {
      ok: true;
      txHash: string;
      // Sweep outcome. The burn itself succeeded; the sweep of the retained cut
      // (fees + manualDeduction) is decoupled. `feeTransferTxHash` is set when
      // it ran inline; `feeTransferPending` is true when it still needs running
      // (retry via feeTransferAction), with the reason in `feeTransferError`.
      feeAmount?: string | null;
      feeTransferTxHash?: string | null;
      feeTransferPending?: boolean;
      feeTransferError?: string | null;
    };

export type FeeTransferActionResult =
  | { error: string }
  | {
      ok: true;
      feeTransferTxHash: string;
      feeAmount: string | null;
      alreadyTransferred: boolean;
    };

// CP's own error strings are admin-facing and usually actionable ("merchant
// not connected", "payout already paid", …) so we surface them directly;
// anything else degrades to a generic translated message with the detail
// logged server-side.
function toMessage(e: unknown, generic: string): string {
  if (e instanceof CitizenPayApiError && e.message) return e.message;
  return generic;
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

export async function previewPayoutDraftAction(input: {
  placeId: string;
  from: string;
  to: string;
}): Promise<PreviewPayoutResult> {
  const t = await getTranslations("fund.payments.settlement.errors");
  const { fund } = await requireFundRole("ADMIN");

  const parsed = PayoutRangeSchema.safeParse(input);
  if (!parsed.success) {
    const key = parsed.error.issues[0]?.message ?? "previewFailed";
    return { error: t(key.split(".").pop() as never) };
  }

  try {
    const client = getCitizenPayClient(fund);
    const preview = await client.previewPayoutDraft({
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
    console.error("[payout] previewPayoutDraft failed", input, e);
    return { error: toMessage(e, t("previewFailed")) };
  }
}

export type CreatePayoutResult =
  | { error: string }
  | { ok: true; payoutId: string; orderCount: number; net: string };

export async function createPayoutAction(input: {
  placeId: string;
  from: string;
  to: string;
}): Promise<CreatePayoutResult> {
  const t = await getTranslations("fund.payments.settlement.errors");
  const { fund } = await requireFundRole("ADMIN");

  const parsed = PayoutRangeSchema.safeParse(input);
  if (!parsed.success) {
    const key = parsed.error.issues[0]?.message ?? "createFailed";
    return { error: t(key.split(".").pop() as never) };
  }

  try {
    const client = getCitizenPayClient(fund);
    const created = await client.createPayout({
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
    console.error("[payout] createPayout failed", input, e);
    return { error: toMessage(e, t("createFailed")) };
  }
}

export type PayoutStatusResult =
  | { error: string }
  | { ok: true; status: PayoutStatus };

// =============================================================================
// Order reconciliation — fix unsettled orders on-chain, then tell the server
// =============================================================================
// The API server does NOT mint/burn. When a pending payout has an order with
// no settled on-chain tx, the dashboard fixes it with its own minter wallet,
// mirroring a real payment: the payer is debited the full `total`, the place
// is credited the `net` (total − fee), and the treasury keeps the fee.
//   - payer account     → burn `total` from the payer, then mint `net` to the place;
//   - no payer account  → mint `net` to the place (nothing to burn).
// We then POST the resulting mint tx hash back so the server re-runs its
// confirmation lifecycle.

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

  if (!fund.tokenAddress || fund.tokenChainId == null) {
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
    return { error: toMessage(e, t("payerFailed")) };
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

export type FixOrderResult =
  | { error: string }
  | { ok: true; txHash: string };

export async function fixOrderAction(input: {
  payoutId: string;
  orderId: number;
  account: string | null; // payer; null ⇒ mint-only
  placeAccount: string | null; // mint destination
  total: string; // EUR decimal — burned from the payer
  net: string; // EUR decimal (total − fee) — minted to the place
}): Promise<FixOrderResult> {
  const t = await getTranslations("fund.payments.settlement.errors");
  const { fund } = await requireFundRole("ADMIN");

  if (!input.placeAccount) return { error: t("noPlaceAccount") };

  // Burn the full total from the payer first (when there is one), then credit
  // the place its net. The fee is the difference, retained by the treasury.
  // A mint failure after a successful burn is surfaced with the hash so the
  // operator can recover.
  if (input.account) {
    const burn = await manualBurnDirectAction(
      {
        from: input.account,
        amount: input.total,
      },
      { trigger: ANNOTATION_TRIGGERS.orderSettlementBurn },
    );
    if ("error" in burn) return { error: burn.error };
  }

  const mint = await manualMintDirectAction(
    {
      to: input.placeAccount,
      amount: input.net,
    },
    { trigger: ANNOTATION_TRIGGERS.orderSettlementMint },
  );
  if ("error" in mint) return { error: mint.error };

  // Record the mint hash on the order so the server confirms it. If this
  // fails the funds have already moved — surface the hash so the operator
  // doesn't re-mint.
  try {
    const client = getCitizenPayClient(fund);
    await client.recordOrderTxHash(input.payoutId, input.orderId, mint.txHash);
  } catch (e) {
    console.error("[payout] recordOrderTxHash failed", input.orderId, e);
    return {
      error: `${toMessage(e, t("recordFailed"))} (tx ${mint.txHash})`,
    };
  }

  revalidatePath(`/payments/payouts/${input.payoutId}`);
  return { ok: true, txHash: mint.txHash };
}

export type ArchiveOrderResult =
  | { error: string }
  | { ok: true; payout: ArchivedPayout };

export async function archiveOrderAction(input: {
  payoutId: string;
  orderId: number;
}): Promise<ArchiveOrderResult> {
  const t = await getTranslations("fund.payments.settlement.errors");
  const { fund } = await requireFundRole("ADMIN");

  try {
    const client = getCitizenPayClient(fund);
    const payout = await client.archiveOrder(input.payoutId, input.orderId);
    revalidatePath(`/payments/payouts/${input.payoutId}`);
    return { ok: true, payout };
  } catch (e) {
    console.error("[payout] archiveOrder failed", input.orderId, e);
    return { error: toMessage(e, t("archiveFailed")) };
  }
}

// =============================================================================
// Manual order creation — add an off-CP amount to a pending payout
// =============================================================================
// The operator can add an order by hand: either from a mirrored incoming bank
// transaction (its reference becomes the order description, its amount the
// order total) or by typing the amount + fee + description directly. Backed by
// a guessed CP endpoint — see services/citizenpay/api.ts::payouts.createOrder.

export type CreatePayoutOrderResult =
  | { error: string }
  // Order created AND its net minted to the place (txHash recorded).
  | { ok: true; order: PayoutOrder; payout: ArchivedPayout; txHash: string }
  // Order created but the automatic mint failed — it lands in "Issues" for a
  // manual Fix. `mintError` explains why so the operator isn't left guessing.
  | { ok: true; order: PayoutOrder; payout: ArchivedPayout; mintError: string };

export async function createPayoutOrderAction(input: {
  payoutId: string;
  total: string;
  fees: string;
  description: string | null;
}): Promise<CreatePayoutOrderResult> {
  const t = await getTranslations("fund.payments.settlement.errors");
  const { fund } = await requireFundRole("ADMIN");

  const parsed = CreatePayoutOrderSchema.safeParse(input);
  if (!parsed.success) {
    const key = parsed.error.issues[0]?.message ?? "createOrderFailed";
    return { error: t(key.split(".").pop() as never) };
  }

  const client = getCitizenPayClient(fund);

  // 1. Create the order (rolls its amount into the payout totals). A failure
  //    here is safe to retry — nothing has been created yet.
  let order: PayoutOrder;
  let payout: ArchivedPayout;
  try {
    ({ order, payout } = await client.createPayoutOrder(parsed.data.payoutId, {
      total: parsed.data.total,
      fees: parsed.data.fees,
      description: parsed.data.description?.trim() || null,
    }));
  } catch (e) {
    console.error("[payout] createPayoutOrder failed", input, e);
    return { error: toMessage(e, t("createOrderFailed")) };
  }

  // The order now exists. Show it immediately, then reconcile it the same way
  // the per-order "Fix" does: mint the net to the place and record the hash.
  // A manual order has no payer account, so this is mint-only (no burn).
  // Past this point we never return a bare { error } — the order is created, so
  // any mint failure comes back as { ok, mintError } to avoid duplicate creates.
  revalidatePath(`/payments/payouts/${parsed.data.payoutId}`);

  let placeAccount: string | null = null;
  try {
    const page = await client.getPayoutOrders(parsed.data.payoutId, {
      limit: 1,
      offset: 0,
    });
    placeAccount = page.placeAccountAddress ?? null;
  } catch (e) {
    console.error("[payout] resolve place account failed", parsed.data, e);
  }
  if (!placeAccount) {
    return { ok: true, order, payout, mintError: t("noPlaceAccount") };
  }

  const mint = await manualMintDirectAction(
    {
      to: placeAccount,
      amount: order.net,
    },
    { trigger: ANNOTATION_TRIGGERS.orderSettlementMint },
  );
  if ("error" in mint) {
    return { ok: true, order, payout, mintError: mint.error };
  }

  // Record the mint hash so the order reads as confirmed. If this fails the
  // tokens have already moved — surface the hash so it isn't re-minted.
  try {
    await client.recordOrderTxHash(parsed.data.payoutId, order.id, mint.txHash);
  } catch (e) {
    console.error("[payout] recordOrderTxHash failed", order.id, e);
    return {
      ok: true,
      order,
      payout,
      mintError: `${toMessage(e, t("recordFailed"))} (tx ${mint.txHash})`,
    };
  }

  revalidatePath(`/payments/payouts/${parsed.data.payoutId}`);
  return { ok: true, order, payout, txHash: mint.txHash };
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
}): Promise<PayoutStatusResult> {
  const t = await getTranslations("fund.payments.settlement.errors");
  const { fund } = await requireFundRole("ADMIN");

  try {
    const client = getCitizenPayClient(fund);
    const { status } = await client.getPayoutStatus(input.payoutId);
    // /status self-heals (flips to complete + sends email when Ponto
    // confirms), and the detail page re-reads the signing URL — so revalidate
    // the detail path too.
    revalidatePath(`/payments/payouts/${input.payoutId}`);
    return { ok: true, status };
  } catch (e) {
    console.error("[payout] getPayoutStatus failed", input.payoutId, e);
    return { error: toMessage(e, t("statusFailed")) };
  }
}

export async function createPayoutPaymentAction(input: {
  payoutId: string;
}): Promise<CreatePayoutPaymentResult> {
  const t = await getTranslations("fund.payments.settlement.errors");
  const { fund } = await requireFundRole("ADMIN");

  try {
    const client = getCitizenPayClient(fund);
    await client.createPayoutPayment(input.payoutId);
    // The detail page re-reads status (now payment-pending) + signing URL.
    revalidatePath(`/payments/payouts/${input.payoutId}`);
    return { ok: true };
  } catch (e) {
    console.error("[payout] createPayoutPayment failed", input.payoutId, e);
    return { error: toMessage(e, t("payFailed")) };
  }
}

// Burn step. CP no longer burns server-side — the dashboard burns the place's
// tokens (the payout `net`) with its own minter wallet, then reports the hash
// to CP, which marks the payout `burnt`. Mirrors the order-reconciliation burn
// (`fixOrderAction`), reusing `manualBurnDirectAction` so the op is recorded as
// a TokenOperation. The burn is only valid while the payout is `pending`; we
// re-check live status first so a re-click can't burn a second time.
export async function burnPayoutAction(input: {
  payoutId: string;
}): Promise<BurnPayoutResult> {
  const t = await getTranslations("fund.payments.settlement.errors");
  const { fund, user } = await requireFundRole("ADMIN");

  try {
    const client = getCitizenPayClient(fund);

    // Idempotency guard: the burn button only shows while `pending`, and CP
    // flips the payout to `burnt` the instant it records our hash. Re-checking
    // live status here means a stale/duplicate submit can't double-burn.
    const { status } = await client.getPayoutStatus(input.payoutId);
    if (status !== "pending") return { error: t("notBurnable") };

    // Amount = the payout `net` (total − fees − manualDeduction): the tokens
    // the place holds for this payout. Read straight from the detail endpoint.
    let payout;
    try {
      payout = await client.getPayout(input.payoutId);
    } catch {
      return { error: t("payoutNotFound") };
    }

    // Source = the place's wallet (each order's net was minted there). It rides
    // on the orders-page envelope — one row is enough to read it.
    const ordersPage = await client.getPayoutOrders(input.payoutId, {
      limit: 1,
    });
    const placeAccount = ordersPage.placeAccountAddress;
    if (!placeAccount) return { error: t("noPlaceAccount") };

    // Burn only the `net` on-chain with our minter (records a TokenOperation).
    // The place account also holds the retained cut (fees + manualDeduction);
    // CP sweeps that to our minter account when we pass `destination` below.
    const burn = await manualBurnDirectAction(
      {
        from: placeAccount,
        amount: payout.net,
      },
      { trigger: ANNOTATION_TRIGGERS.payoutBurn },
    );
    if ("error" in burn) return { error: burn.error };

    // Report the hash so CP marks the payout burnt, and hand CP the minter
    // smart account as the sweep destination for the retained cut. A non-2xx
    // here means the BURN record failed — the tokens are already gone, so
    // surface the hash and do NOT retry (re-running would burn again). A 2xx
    // means the burn is recorded; the sweep is reported in the body and may be
    // pending (retry via feeTransferAction) without being a burn failure.
    let report;
    try {
      report = await client.burnPayout(
        input.payoutId,
        burn.txHash,
        fund.tokenMinterSmartAccountAddress ?? undefined,
      );
    } catch (e) {
      console.error("[payout] reporting burn to CP failed", input.payoutId, e);
      return { error: `${t("reportFailed")} (tx ${burn.txHash})` };
    }

    // The burn itself is annotated inside manualBurnDirectAction (trigger
    // PAYOUT_BURN, acting admin). The fee sweep is CP's own userOp — annotate it
    // here: a userOp's settlement tx hash isn't final until `success` (a retry
    // can change it), so we resolve once now and queue if still pending.
    if (report.feeTransferTxHash) {
      await resolveOrEnqueueAnnotation({
        fundId: fund.id,
        chainId: fund.tokenChainId,
        userOpHash: report.feeTransferTxHash,
        kind: ANNOTATION_TRIGGERS.payoutFee,
        trigger: ANNOTATION_TRIGGERS.payoutFee,
        triggeredByUserId: user.id,
      });
    }

    revalidatePath("/payments");
    revalidatePath(`/payments/payouts/${input.payoutId}`);
    return {
      ok: true,
      txHash: burn.txHash,
      feeAmount: report.feeAmount,
      feeTransferTxHash: report.feeTransferTxHash,
      feeTransferPending: report.feeTransferPending,
      feeTransferError: report.feeTransferError,
    };
  } catch (e) {
    console.error("[payout] burnPayout failed", input.payoutId, e);
    return { error: toMessage(e, t("burnFailed")) };
  }
}

// Run (or retry) just the fee sweep for an already-burned payout — the
// standalone, idempotent counterpart to the burn's inline sweep. Used when a
// burn's sweep came back pending (or to sweep later). Sweeps to the fund's
// minter account, same destination as the inline path. Idempotent on CP's side,
// so a retry after a lost response won't double-transfer.
export async function feeTransferAction(input: {
  payoutId: string;
}): Promise<FeeTransferActionResult> {
  const t = await getTranslations("fund.payments.settlement.errors");
  const { fund, user } = await requireFundRole("ADMIN");

  const destination = fund.tokenMinterSmartAccountAddress;
  if (!destination) return { error: t("noFeeDestination") };

  try {
    const client = getCitizenPayClient(fund);
    const res = await client.feeTransfer(input.payoutId, destination);
    // CP returns a userOp hash — resolve to the real tx hash now if it's
    // already settled, otherwise queue for the cron.
    await resolveOrEnqueueAnnotation({
      fundId: fund.id,
      chainId: fund.tokenChainId,
      userOpHash: res.feeTransferTxHash,
      kind: ANNOTATION_TRIGGERS.payoutFee,
      trigger: ANNOTATION_TRIGGERS.payoutFee,
      triggeredByUserId: user.id,
    });
    revalidatePath("/payments");
    revalidatePath(`/payments/payouts/${input.payoutId}`);
    refresh();
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
    console.error("[payout] feeTransfer failed", input.payoutId, e);
    return { error: toMessage(e, t("feeTransferFailed")) };
  }
}

export type SetManualDeductionResult =
  | { error: string }
  | { ok: true; payout: PayoutDeduction };

// Set/clear a payout's manual deduction (+ comment). This is a pure ledger
// adjustment on CP's side — it lowers the `net` the merchant is paid, with no
// on-chain effect. Only mutable while the payout isn't complete; we pre-check
// status (and that the deduction can't drive net negative) for a clear message,
// but CP is the final authority.
export async function setManualDeductionAction(input: {
  payoutId: string;
  amount: string;
  comment: string | null;
}): Promise<SetManualDeductionResult> {
  const t = await getTranslations("fund.payments.settlement.errors");
  const { fund } = await requireFundRole("ADMIN");

  const parsed = SetManualDeductionSchema.safeParse(input);
  if (!parsed.success) {
    const key = parsed.error.issues[0]?.message ?? "deductionFailed";
    return { error: t(key.split(".").pop() as never) };
  }

  const client = getCitizenPayClient(fund);

  // Need the current totals both to validate the bound and (live status) to
  // confirm the payout is still editable.
  let payout;
  try {
    payout = await client.getPayout(parsed.data.payoutId);
  } catch {
    return { error: t("payoutNotFound") };
  }

  const { status } = await client.getPayoutStatus(parsed.data.payoutId);
  if (status !== "pending") return { error: t("deductionNotPending") };

  // A deduction larger than (total − fees) would drive net negative.
  const maxDeduction = Number(payout.totalAmount) - Number(payout.totalFees);
  if (Number(parsed.data.amount) > maxDeduction) {
    return { error: t("deductionTooHigh") };
  }

  try {
    const updated = await client.setManualDeduction(parsed.data.payoutId, {
      amount: parsed.data.amount,
      comment: parsed.data.comment?.trim() || null,
    });
    revalidatePath("/payments");
    revalidatePath(`/payments/payouts/${parsed.data.payoutId}`);
    // Refresh the client router so the detail header (net + deduction row)
    // re-renders. Must run here in the Server Action — `refresh` throws if
    // called from a Client Component.
    refresh();
    return { ok: true, payout: updated };
  } catch (e) {
    console.error("[payout] setManualDeduction failed", input, e);
    return { error: toMessage(e, t("deductionFailed")) };
  }
}

// Clear a payout's manual deduction (+ comment), net back to total − fees.
// Same pending-only gate as setting it.
export async function clearManualDeductionAction(input: {
  payoutId: string;
}): Promise<SetManualDeductionResult> {
  const t = await getTranslations("fund.payments.settlement.errors");
  const { fund } = await requireFundRole("ADMIN");

  const client = getCitizenPayClient(fund);

  const { status } = await client.getPayoutStatus(input.payoutId);
  if (status !== "pending") return { error: t("deductionNotPending") };

  try {
    const updated = await client.clearManualDeduction(input.payoutId);
    revalidatePath("/payments");
    revalidatePath(`/payments/payouts/${input.payoutId}`);
    refresh();
    return { ok: true, payout: updated };
  } catch (e) {
    console.error("[payout] clearManualDeduction failed", input.payoutId, e);
    return { error: toMessage(e, t("deductionFailed")) };
  }
}

export type CompletePayoutResult = { error: string } | { ok: true };

// Admin override: mark a payout complete without burning or paying — for when
// the treasury settled with the merchant another way. Confirmed in the UI
// before firing (it bypasses settlement and can't be undone).
export async function completePayoutAction(input: {
  payoutId: string;
}): Promise<CompletePayoutResult> {
  const t = await getTranslations("fund.payments.settlement.errors");
  const { fund } = await requireFundRole("ADMIN");

  try {
    const client = getCitizenPayClient(fund);
    await client.completePayout(input.payoutId);
    revalidatePath("/payments");
    revalidatePath(`/payments/payouts/${input.payoutId}`);
    return { ok: true };
  } catch (e) {
    console.error("[payout] completePayout failed", input.payoutId, e);
    return { error: toMessage(e, t("completeFailed")) };
  }
}
