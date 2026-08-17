// SPDX-License-Identifier: AGPL-3.0-or-later

// Accounting export for merchant payouts — the "récapitulatif détaillé de
// chaque somme perçue et reversée par tiers" a fund's accountant asks for.
// Payouts are the right source because every one of them is tied to exactly
// one merchant place, so the per-third-party breakdown comes for free.
//
// Pure module (no "use server", no "server-only", no I/O): the client form
// imports the presets + schema, the operations engine imports the row builder,
// and ./export.test.ts covers the lot. The CitizenPay fetch lives in
// ./operations.ts, which is where every other fund-scoped payout read lives.
//
// ---------------------------------------------------------------------------
// Which date, and why
// ---------------------------------------------------------------------------
// A payout carries three date-ish things: its settlement period
// (`startDate`/`endDate`), `createdAt`, and `updatedAt`. The dashboard's payout
// tables lead with the period, and the period is also the only one with
// accounting meaning — it's the window the merchant's takings were earned in.
// So the range filter matches on the **period start day**, and both period
// bounds ship as columns. `createdAt` / `updatedAt` ride along as audit
// columns (when the payout was cut, when it last moved) but never drive the
// filter: filtering on the period start makes contiguous exports partition the
// payouts exactly once each, with no payout duplicated across two months and
// none dropped.
//
// Period days are read with UTC getters, not local ones: CitizenPay stores the
// bounds as UTC midnights (see the note in the payout period dialog), so local
// getters would shift the day for anyone west of Greenwich.
//
// `endDate` is exclusive (a payout labelled "July" ends on 2026-08-01), which
// reads as a double count to an accountant scanning consecutive rows. The
// export writes the inclusive last day covered instead — 2026-07-31 — and the
// column label says so.
//
// ---------------------------------------------------------------------------
// Which statuses
// ---------------------------------------------------------------------------
// All of them. A payout's lifecycle is pending → payment-pending → burnt →
// complete; there is no draft or cancelled state to exclude (drafts aren't
// payouts at all — they're recomputed order groupings that CitizenPay never
// stores). An accountant needs the committed-but-unpaid rows as much as the
// settled ones, so everything is included and the `status` column is what
// separates "reversé" from "à reverser".

import { z } from "zod";

import type { Payout } from "@/services/citizenpay/types";
import {
  CSV_DELIMITER,
  formatCsvDecimal,
  serializeCsv,
} from "@/services/csv/serialize";

import { fromCents, toCents } from "./money";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// =============================================================================
// Range: presets + validation
// =============================================================================

// Accounting-shaped windows (calendar months, quarters, years) rather than the
// rolling "last 7 / last 30 days" the bank transactions filter offers — nobody
// closes their books on a rolling window.
export type PayoutExportPreset =
  | "thisMonth"
  | "lastMonth"
  | "thisQuarter"
  | "lastQuarter"
  | "thisYear"
  | "lastYear";

export const PAYOUT_EXPORT_PRESETS: readonly PayoutExportPreset[] = [
  "thisMonth",
  "lastMonth",
  "thisQuarter",
  "lastQuarter",
  "thisYear",
  "lastYear",
];

export const DEFAULT_PAYOUT_EXPORT_PRESET: PayoutExportPreset = "lastMonth";

/** An inclusive `[from, to]` pair of `YYYY-MM-DD` days — what the URL carries. */
export type PayoutExportRange = { from: string; to: string };

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

// UTC calendar arithmetic, matching how the period bounds are stored. The
// Date.UTC constructor normalises overflow (month 12 → next January, day 0 →
// last day of the previous month), so every boundary below is one expression.
function day(year: number, monthIndex: number, dayOfMonth: number): string {
  return utcDay(new Date(Date.UTC(year, monthIndex, dayOfMonth)));
}

/**
 * Resolve a preset to the inclusive `[from, to]` days it stands for, in UTC.
 * Shared by the client's preset buttons and the server's default range so the
 * two can never disagree.
 */
export function resolvePayoutExportPreset(
  preset: PayoutExportPreset,
  now: Date = new Date(),
): PayoutExportRange {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const quarterStart = Math.floor(m / 3) * 3;

  switch (preset) {
    case "thisMonth":
      return { from: day(y, m, 1), to: day(y, m + 1, 0) };
    case "lastMonth":
      return { from: day(y, m - 1, 1), to: day(y, m, 0) };
    case "thisQuarter":
      return { from: day(y, quarterStart, 1), to: day(y, quarterStart + 3, 0) };
    case "lastQuarter":
      return { from: day(y, quarterStart - 3, 1), to: day(y, quarterStart, 0) };
    case "thisYear":
      return { from: day(y, 0, 1), to: day(y, 11, 31) };
    case "lastYear":
      return { from: day(y - 1, 0, 1), to: day(y - 1, 11, 31) };
  }
}

// Both days are required and inclusive, so a single-day export (from === to) is
// valid. Messages are i18n keys, resolved by whoever holds a translator — the
// same convention as ./schemas.ts.
export const PayoutExportRangeSchema = z
  .object({
    from: z.string().regex(DAY, "fund.payments.settlement.errors.rangeInvalid"),
    to: z.string().regex(DAY, "fund.payments.settlement.errors.rangeInvalid"),
  })
  .refine((d) => d.from <= d.to, {
    message: "fund.payments.settlement.errors.rangeOrder",
    path: ["to"],
  });

export type PayoutExportRangeInput = z.infer<typeof PayoutExportRangeSchema>;

/**
 * Resolve the range the page should show: whatever valid `from`/`to` the URL
 * carries, else the default preset. Never throws — a malformed URL falls back
 * rather than erroring the page.
 */
export function resolvePayoutExportRange(
  from: string | undefined,
  to: string | undefined,
  now: Date = new Date(),
): PayoutExportRange {
  const parsed = PayoutExportRangeSchema.safeParse({ from, to });
  return parsed.success
    ? parsed.data
    : resolvePayoutExportPreset(DEFAULT_PAYOUT_EXPORT_PRESET, now);
}

// =============================================================================
// Selection
// =============================================================================

/** The UTC calendar day a payout's settlement period starts on. */
export function payoutPeriodStartDay(payout: Payout): string {
  return utcDay(new Date(payout.startDate));
}

/**
 * The last day the settlement period actually covers. `endDate` is the
 * exclusive upper bound, so this is the day before it.
 */
export function payoutPeriodEndDay(payout: Payout): string {
  const end = new Date(payout.endDate);
  end.setUTCDate(end.getUTCDate() - 1);
  return utcDay(end);
}

/**
 * Payouts whose settlement period starts inside the inclusive range, oldest
 * period first then merchant name — the order an accountant reads a ledger in.
 */
export function selectPayoutsForExport(
  payouts: readonly Payout[],
  range: PayoutExportRange,
): Payout[] {
  return payouts
    .filter((p) => {
      const start = payoutPeriodStartDay(p);
      return start >= range.from && start <= range.to;
    })
    .sort((a, b) => {
      const byDay = payoutPeriodStartDay(a).localeCompare(payoutPeriodStartDay(b));
      if (byDay !== 0) return byDay;
      const byPlace = (a.placeName ?? "").localeCompare(b.placeName ?? "");
      return byPlace !== 0 ? byPlace : a.id.localeCompare(b.id);
    });
}

/**
 * The same selection rolled up per merchant — the on-screen preview of what the
 * file contains, so the operator can sanity-check a window before downloading
 * it. Summed in integer cents (adding EUR decimal strings as floats
 * accumulates dust), heaviest payer first.
 */
export type MerchantExportSummary = {
  placeId: string;
  merchant: string | null;
  payoutCount: number;
  gross: string;
  processorFees: string;
  platformFee: string;
  net: string;
};

export function summarizePayoutsByMerchant(
  payouts: readonly Payout[],
): MerchantExportSummary[] {
  const byPlace = new Map<
    string,
    {
      placeId: string;
      merchant: string | null;
      payoutCount: number;
      gross: number;
      processorFees: number;
      platformFee: number;
      net: number;
    }
  >();

  for (const p of payouts) {
    const entry = byPlace.get(p.placeId) ?? {
      placeId: p.placeId,
      merchant: p.placeName,
      payoutCount: 0,
      gross: 0,
      processorFees: 0,
      platformFee: 0,
      net: 0,
    };
    entry.merchant ??= p.placeName;
    entry.payoutCount += 1;
    entry.gross += toCents(p.totalAmount);
    entry.processorFees += toCents(p.totalFees);
    entry.platformFee += toCents(p.totalPayoutFees);
    entry.net += toCents(p.net);
    byPlace.set(p.placeId, entry);
  }

  return [...byPlace.values()]
    .sort((a, b) => b.net - a.net || (a.merchant ?? "").localeCompare(b.merchant ?? ""))
    .map((e) => ({
      placeId: e.placeId,
      merchant: e.merchant,
      payoutCount: e.payoutCount,
      gross: fromCents(e.gross),
      processorFees: fromCents(e.processorFees),
      platformFee: fromCents(e.platformFee),
      net: fromCents(e.net),
    }));
}

// =============================================================================
// Rows
// =============================================================================

// One column per figure the accountant reconciles, in reading order. The three
// fee-ish columns are NOT interchangeable (see services/payout/money.ts):
// `processorFees` was withheld at source by the payment processor and never
// reached us, `platformFee` is the fund's own cut swept at settlement, and
// `manualDeduction` is an admin adjustment. gross − the three = net, which is
// what the merchant was actually wired.
export const PAYOUT_EXPORT_COLUMNS = [
  "periodStart",
  "periodEnd",
  "merchant",
  "business",
  "gross",
  "processorFees",
  "platformFee",
  "manualDeduction",
  "deductionComment",
  "net",
  "status",
  "createdAt",
  "reference",
] as const;

export type PayoutExportColumn = (typeof PAYOUT_EXPORT_COLUMNS)[number];

/** Resolves an i18n key — the root translator, same shape as PayoutContext.t. */
export type ExportTranslate = (key: string) => string;

// ISO `YYYY-MM-DD HH:mm` in UTC for the audit timestamps. Deliberately not
// locale-formatted: `01/07/2026` is 1 July in fr and 7 January in en, and a CSV
// carries no hint which one it meant. ISO is unambiguous and every spreadsheet
// parses it as a date.
function utcMinute(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 16).replace("T", " ");
}

function row(
  payout: Payout,
  locale: string,
  t: ExportTranslate,
): Record<PayoutExportColumn, string> {
  const money = (value: string) => formatCsvDecimal(value, locale);
  return {
    periodStart: payoutPeriodStartDay(payout),
    periodEnd: payoutPeriodEndDay(payout),
    merchant: payout.placeName ?? "",
    business: payout.businessName ?? "",
    gross: money(payout.totalAmount),
    processorFees: money(payout.totalFees),
    platformFee: money(payout.totalPayoutFees),
    manualDeduction: money(payout.manualDeduction),
    deductionComment: payout.manualDeductionComment ?? "",
    net: money(payout.net),
    status: t(`fund.payments.settlement.statuses.${payout.status}`),
    createdAt: utcMinute(payout.createdAt),
    reference: payout.id,
  };
}

// =============================================================================
// File
// =============================================================================

// `payouts_<fund>_<from>_<to>.csv`. The fund part is the first label of its
// domain (`acme` for both `acme.lacaisse.eu` and a custom `funds.acme.com`),
// asciified so no header-encoding surprises reach Content-Disposition.
export function payoutExportFilename(
  fundDomain: string,
  range: PayoutExportRange,
): string {
  const label =
    fundDomain
      .split(".")[0]
      ?.normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "fund";
  return `payouts_${label}_${range.from}_${range.to}.csv`;
}

export type PayoutExportFile = {
  filename: string;
  csv: string;
  /** How many payouts made it into the file — surfaced to the operator. */
  count: number;
};

/**
 * Build the downloadable file from an already-fetched payout list. Headers and
 * statuses are localized through `t`; amounts through the locale's decimal
 * separator (see services/csv/serialize.ts for the Excel reasoning).
 */
export function buildPayoutExportCsv(input: {
  payouts: readonly Payout[];
  range: PayoutExportRange;
  fundDomain: string;
  locale: string;
  t: ExportTranslate;
}): PayoutExportFile {
  const { payouts, range, fundDomain, locale, t } = input;
  const selected = selectPayoutsForExport(payouts, range);
  const header = PAYOUT_EXPORT_COLUMNS.map((c) =>
    t(`fund.payments.export.columns.${c}`),
  );
  const rows = selected.map((p) => {
    const cells = row(p, locale, t);
    return PAYOUT_EXPORT_COLUMNS.map((c) => cells[c]);
  });

  return {
    filename: payoutExportFilename(fundDomain, range),
    csv: serializeCsv([header, ...rows], { delimiter: CSV_DELIMITER }),
    count: selected.length,
  };
}
