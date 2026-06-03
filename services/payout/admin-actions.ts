// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";

import { getBalances } from "@/services/alchemy/balances";
import { formatTokenAmount } from "@/services/alchemy/format";
import { listTransfersForAccount } from "@/services/alchemy/transfers";
import { requireFundRole } from "@/services/auth/dal";
import { CitizenPayApiError } from "@/services/citizenpay/api";
import { getCitizenPayClient } from "@/services/citizenpay/client";
import type {
  ArchivedPayout,
  PayoutOrder,
  PayoutStatus,
} from "@/services/citizenpay/types";
import { prisma } from "@/services/db/prisma";
import {
  manualBurnDirectAction,
  manualMintDirectAction,
} from "@/services/token-operations/admin-actions";

import { resolveOrderReceipts, type TxReceiptStatus } from "./receipts";
import {
  CreatePayoutOrderSchema,
  PayoutRangeSchema,
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

export type BurnPayoutResult = { error: string } | { ok: true; txHash: string };

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
    const burn = await manualBurnDirectAction({
      from: input.account,
      amount: input.total,
    });
    if ("error" in burn) return { error: burn.error };
  }

  const mint = await manualMintDirectAction({
    to: input.placeAccount,
    amount: input.net,
  });
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
  | { ok: true; order: PayoutOrder; payout: ArchivedPayout };

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

  try {
    const client = getCitizenPayClient(fund);
    const { order, payout } = await client.createPayoutOrder(
      parsed.data.payoutId,
      {
        total: parsed.data.total,
        fees: parsed.data.fees,
        description: parsed.data.description?.trim() || null,
      },
    );
    revalidatePath(`/payments/payouts/${parsed.data.payoutId}`);
    return { ok: true, order, payout };
  } catch (e) {
    console.error("[payout] createPayoutOrder failed", input, e);
    return { error: toMessage(e, t("createOrderFailed")) };
  }
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
  | { ok: true; transactions: PickableBankTransaction[] };

export async function listIncomingBankTransactionsAction(): Promise<ListIncomingBankTransactionsResult> {
  const t = await getTranslations("fund.payments.settlement.errors");
  const { fund } = await requireFundRole("ADMIN");

  try {
    const rows = await prisma.bankTransaction.findMany({
      where: { fundId: fund.id, direction: "INCOMING" },
      orderBy: { occurredAt: "desc" },
      take: 50,
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
    return {
      ok: true,
      transactions: rows.map((b) => ({
        id: b.id,
        occurredAt: b.occurredAt.toISOString(),
        amount: b.amount.toFixed(2),
        currency: b.currency,
        counterpartName: b.counterpartName,
        reference: b.counterpartReference ?? b.remittanceInfo ?? null,
      })),
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

export async function burnPayoutAction(input: {
  payoutId: string;
}): Promise<BurnPayoutResult> {
  const t = await getTranslations("fund.payments.settlement.errors");
  const { fund } = await requireFundRole("ADMIN");

  try {
    const client = getCitizenPayClient(fund);
    const { txHash } = await client.burnPayout(input.payoutId);
    revalidatePath("/payments");
    return { ok: true, txHash };
  } catch (e) {
    console.error("[payout] burnPayout failed", input.payoutId, e);
    return { error: toMessage(e, t("burnFailed")) };
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
