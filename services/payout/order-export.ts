// SPDX-License-Identifier: AGPL-3.0-or-later

// Transaction-level accounting export — the sibling of ./export.ts.
//
// ./export.ts is the *récapitulatif*: one row per payout, i.e. one line per
// merchant per settlement period. This module is the *détail*: one row per
// order inside those payouts, so the accountant can see each individual sum
// and where it came from. Same period picker, same range semantics, same CSV
// conventions — only the granularity differs.
//
// Pure module (no "use server", no "server-only", no I/O): the CitizenPay
// fetching lives in ./operations.ts, and ./order-export.test.ts covers this.
//
// ---------------------------------------------------------------------------
// Which orders
// ---------------------------------------------------------------------------
// Exactly the orders of the payouts the recap selects for the same range — no
// second filter on the orders' own dates. The payout is the accounting unit:
// an order belongs to the period of the payout that settled it, whatever day
// the payer happened to tap their card. Filtering twice would drop the orders
// CitizenPay pulled into a neighbouring period and make the detail file stop
// summing to the recap file, which is the one invariant an accountant checks.
//
// Every row therefore repeats its payout's context (period, merchant, payout
// reference, payout status). That redundancy is deliberate: the file is
// self-joining, so a pivot table on it reproduces the recap without needing
// the other download open.
//
// ---------------------------------------------------------------------------
// "Source of funds"
// ---------------------------------------------------------------------------
// Two answers, in order of precision:
//
//  1. `processor` — the payment provider CitizenPay recorded for the order
//     (`viva`, `ponto`, `stripe`, …). This is the money's actual origin and
//     the thing an accountant reconciles a bank statement against, so it wins
//     whenever it's there. Printed as the brand writes itself ("Viva"), which
//     is the same string in every locale: a company name is not translated.
//  2. the order **type** (`app`, `terminal`, `web`, `manual`, …), localized —
//     the channel the payer used. It's all we have for orders no provider
//     handled (paid in-app from a card balance, or keyed in by an operator),
//     and it's also the fallback for an API deployment that predates the
//     `processor` field: null reads the same either way, and the channel is
//     never wrong, only less precise.
//
// Both sides print unknown values raw rather than as a missing-translation
// key: CitizenPay can add a type or onboard a provider any day, and an
// accounting file must not lose information over it.
//
// `processorFees` is the corroborating signal: it is only ever > 0 when a
// provider withheld its cut before the money reached the wallet, so a row with
// fees > 0 should normally name a processor here.
//
// ---------------------------------------------------------------------------
// Which figures
// ---------------------------------------------------------------------------
// Per order: `gross` (what the payer paid), `processorFees` (withheld at
// source, never reached us), `platformFeeShare` (this order's share of the
// fund's own cut — credited with the order, swept back at settlement) and
// `netCredit` = gross − processorFees, which is what actually landed in the
// merchant's wallet. Deliberately NOT gross − fees − payoutFee: the platform
// cut leaves at the payout-level sweep, so it isn't netted per order. The
// payout-level `manualDeduction` has no per-order meaning at all and stays in
// the recap file.
//
// netCredit is recomputed here in integer cents rather than trusting the
// `net` the client hands over, so the column is guaranteed to reconcile with
// the two it's derived from in the same row.

import type { Payout, PayoutOrder } from "@/services/citizenpay/types";
import {
  CSV_DELIMITER,
  formatCsvDecimal,
  serializeCsv,
} from "@/services/csv/serialize";

import {
  fundFilenameLabel,
  payoutPeriodEndDay,
  payoutPeriodStartDay,
  type ExportTranslate,
  type PayoutExportRange,
} from "./export";
import { fromCents, toCents } from "./money";

// =============================================================================
// Labels for CitizenPay's open-ended enums
// =============================================================================

// The order types seen in production (`web`, `terminal`, `app`, `manual`) plus
// `pos`, the older name the mock client still emits. Anything outside this set
// prints as CitizenPay sent it.
const KNOWN_ORDER_TYPES = new Set(["app", "manual", "pos", "terminal", "web"]);

// Order lifecycle values CitizenPay documents: `paid`, `refund` (a repayment
// out of the merchant's wallet), `refunded` (the original order of a refund)
// and `correction`. Same open-ended treatment as the types.
const KNOWN_ORDER_STATUSES = new Set([
  "correction",
  "paid",
  "refund",
  "refunded",
]);

// The processors CitizenPay names today, spelled the way each brand does.
// Deliberately NOT i18n keys: these are company names, identical in fr/en/es/
// nl, and routing them through the message files would invite a translator to
// "localize" one. Anything CitizenPay onboards later prints capitalized from
// the raw lowercase value, which is right for the overwhelming majority of
// provider names — and still recognisable when it isn't.
const PROCESSOR_NAMES = new Map([
  ["ponto", "Ponto"],
  ["stripe", "Stripe"],
  ["viva", "Viva"],
]);

/** Display name for a payment processor: known brand, else capitalized raw. */
export function processorLabel(processor: string): string {
  return (
    PROCESSOR_NAMES.get(processor.toLowerCase()) ??
    processor.charAt(0).toUpperCase() + processor.slice(1)
  );
}

/**
 * "Source of funds" for an order: the payment processor when CitizenPay named
 * one, otherwise the localized channel (the pre-`processor` behaviour, and
 * still the only answer for app/manual orders).
 */
export function orderSourceLabel(
  order: { processor?: string | null; type: string | null },
  t: ExportTranslate,
): string {
  if (order.processor) return processorLabel(order.processor);
  const { type } = order;
  if (!type) return "";
  return KNOWN_ORDER_TYPES.has(type)
    ? t(`fund.payments.settlement.orderTypes.${type}`)
    : type;
}

/** Localized order status, or the raw value for anything new. */
export function orderStatusLabel(status: string | null, t: ExportTranslate): string {
  if (!status) return "";
  return KNOWN_ORDER_STATUSES.has(status)
    ? t(`fund.payments.settlement.orderStatuses.${status}`)
    : status;
}

// =============================================================================
// Rows
// =============================================================================

/** A payout with the orders it settles — what the engine hands this module. */
export type PayoutOrderExportEntry = {
  payout: Payout;
  orders: readonly PayoutOrder[];
};

export const PAYOUT_ORDER_EXPORT_COLUMNS = [
  "periodStart",
  "periodEnd",
  "merchant",
  "business",
  "reference",
  "payoutStatus",
  "orderId",
  "orderDate",
  "source",
  "gross",
  "processorFees",
  "platformFeeShare",
  "netCredit",
  "orderStatus",
  "description",
  "txHash",
] as const;

export type PayoutOrderExportColumn = (typeof PAYOUT_ORDER_EXPORT_COLUMNS)[number];

// ISO `YYYY-MM-DD HH:mm` in UTC, same as the recap's createdAt column and for
// the same reason: `01/07/2026` is 1 July in fr and 7 January in en, and a CSV
// carries no hint which one it meant.
function utcMinute(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 16).replace("T", " ");
}

/**
 * When the order happened: its completion time, falling back to submission.
 * `completedAt` is what the payout detail table shows, but it can be null
 * (an order that never settled on-chain is exactly the kind of line an
 * accountant is hunting for), and `createdAt` is always there.
 */
export function payoutOrderDate(order: PayoutOrder): string {
  return order.completedAt ?? order.createdAt ?? "";
}

/** Wallet credit for one order: gross − processor fees, in integer cents. */
export function orderNetCreditCents(order: PayoutOrder): number {
  return toCents(order.total) - toCents(order.fees);
}

// Oldest first inside a payout, ties broken by id so the file is stable
// between two downloads of the same window.
function sortOrders(orders: readonly PayoutOrder[]): PayoutOrder[] {
  return [...orders].sort((a, b) => {
    const byDate = payoutOrderDate(a).localeCompare(payoutOrderDate(b));
    return byDate !== 0 ? byDate : a.id - b.id;
  });
}

function row(
  payout: Payout,
  order: PayoutOrder,
  locale: string,
  t: ExportTranslate,
): Record<PayoutOrderExportColumn, string> {
  const money = (value: string | number) => formatCsvDecimal(value, locale);
  return {
    periodStart: payoutPeriodStartDay(payout),
    periodEnd: payoutPeriodEndDay(payout),
    merchant: payout.placeName ?? "",
    business: payout.businessName ?? "",
    reference: payout.id,
    payoutStatus: t(`fund.payments.settlement.statuses.${payout.status}`),
    orderId: String(order.id),
    orderDate: utcMinute(payoutOrderDate(order) || null),
    source: orderSourceLabel(order, t),
    gross: money(order.total),
    processorFees: money(order.fees),
    platformFeeShare: money(order.payoutFee),
    netCredit: money(fromCents(orderNetCreditCents(order))),
    orderStatus: orderStatusLabel(order.status, t),
    description: order.description ?? "",
    txHash: order.txHash ?? "",
  };
}

// =============================================================================
// File
// =============================================================================

/** `payout_orders_<fund>_<from>_<to>.csv` — one row per transaction. */
export function payoutOrderExportFilename(
  fundDomain: string,
  range: PayoutExportRange,
): string {
  return `payout_orders_${fundFilenameLabel(fundDomain)}_${range.from}_${range.to}.csv`;
}

export type PayoutOrderExportFile = {
  filename: string;
  csv: string;
  /** Transaction rows in the file. */
  count: number;
  /** Payouts they came from — the recap file's row count for the same window. */
  payoutCount: number;
};

/**
 * Build the transaction-level file from payouts whose orders have already been
 * fetched. Entries arrive in the order the recap selects them (period, then
 * merchant, then payout id); orders are sorted inside each entry.
 */
export function buildPayoutOrderExportCsv(input: {
  entries: readonly PayoutOrderExportEntry[];
  range: PayoutExportRange;
  fundDomain: string;
  locale: string;
  t: ExportTranslate;
}): PayoutOrderExportFile {
  const { entries, range, fundDomain, locale, t } = input;
  const header = PAYOUT_ORDER_EXPORT_COLUMNS.map((c) =>
    t(`fund.payments.export.orderColumns.${c}`),
  );
  const rows = entries.flatMap((entry) =>
    sortOrders(entry.orders).map((order) => {
      const cells = row(entry.payout, order, locale, t);
      return PAYOUT_ORDER_EXPORT_COLUMNS.map((c) => cells[c]);
    }),
  );

  return {
    filename: payoutOrderExportFilename(fundDomain, range),
    csv: serializeCsv([header, ...rows], { delimiter: CSV_DELIMITER }),
    count: rows.length,
    payoutCount: entries.length,
  };
}
