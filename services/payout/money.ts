// SPDX-License-Identifier: AGPL-3.0-or-later

// Payout fee arithmetic, kept pure (no I/O, no server-only) so the dialogs,
// the operations engine and the dev mock all compute the split the same way.
//
// Two fee figures, two different pots of money:
//   • `fees`       — withheld at source by the payment processor (Viva,
//                    Stripe). The place's wallet was credited `total − fees`,
//                    so these tokens were never minted and are never swept.
//   • `payoutFees` — the fund's transaction fees and its payout (platform)
//                    fee. Minted into the place's wallet; it sits there until
//                    the fee sweep moves it to the fund, except the part a
//                    fund with a fee account already collected right after
//                    each payment (`feesCollectedAtPayment`, api#277).
//
//   net = total − fees − payoutFees − manualDeduction
//
// Everything works in integer cents internally: EUR decimal strings are what
// travel through the app, and adding them as floats accumulates dust
// ("0.1 + 0.2"). Callers hand in and get back 2dp decimal strings.

/** EUR decimal string → integer cents. Non-numeric input reads as 0. */
export function toCents(decimal: string | number | null | undefined): number {
  const n = typeof decimal === "number" ? decimal : Number(decimal ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/** Integer cents → 2dp EUR decimal string. */
export function fromCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

/**
 * What the merchant is actually paid: the burn amount and the SEPA amount.
 * The API computes this server-side — this mirror exists for live previews
 * (dialogs) and for the dev mock's fixtures.
 */
export function payoutNet(parts: {
  total: string;
  fees: string;
  payoutFees: string;
  manualDeduction?: string;
}): string {
  return fromCents(
    toCents(parts.total) -
      toCents(parts.fees) -
      toCents(parts.payoutFees) -
      toCents(parts.manualDeduction ?? "0"),
  );
}

/**
 * The largest deduction that keeps `net` at or above zero: total − fees −
 * payoutFees. Returned in cents so callers can compare without re-parsing;
 * `fromCents` renders it for the UI.
 */
export function maxManualDeductionCents(parts: {
  total: string;
  fees: string;
  payoutFees: string;
}): number {
  return Math.max(
    0,
    toCents(parts.total) - toCents(parts.fees) - toCents(parts.payoutFees),
  );
}

/**
 * What one order credited to the place's wallet: `total − fees`. Correct for
 * every connector — a processor withheld its commission before the credit, a
 * bank-paid order withheld nothing. The platform cut is NOT subtracted here:
 * it was minted with the rest and only leaves at the payout-level sweep.
 */
export function orderWalletCredit(order: {
  total: string;
  fees: string;
}): string {
  return fromCents(toCents(order.total) - toCents(order.fees));
}

/**
 * The fees collected at payment time a payout may count, in cents: what the
 * api reports, clamped to [0, payoutFees] — they are part of `payoutFees`, so
 * more than that is a bad answer and must never lower what the wallet has to
 * hold, nor the sweep, below what it is without them. Absent = 0.
 */
export function collectedAtPaymentCents(p: {
  totalPayoutFees?: string | null;
  feesCollectedAtPayment?: string | null;
}): number {
  const collected = toCents(p.feesCollectedAtPayment ?? "0");
  if (collected <= 0) return 0;
  return Math.min(collected, Math.max(0, toCents(p.totalPayoutFees ?? "0")));
}

/**
 * What settling a payout takes out of the place's wallet: the burn (`net`)
 * plus the sweep (`payoutFees + manualDeduction − feesCollectedAtPayment`) —
 * which is `total − fees − feesCollectedAtPayment`. Every order credited the
 * wallet `total − fees`; the processor's commission (`fees`) was withheld at
 * source, so no token was ever minted for it; and for a fund with a fee
 * account (citizenpay/api#277) the transaction fees already sent to that
 * account right after each payment left the wallet then. The payout page's
 * balance stat, the burn's balance preflight and the backing check all
 * measure against this figure.
 *
 * Guarded against a bad `feesCollectedAtPayment`: it is clamped to
 * `payoutFees` (collectedAtPaymentCents), and the result never drops below
 * `net + manualDeduction` (what the burn and the deduction's sweep need
 * whatever the fees did) when the payout's `net` is given. Absent = 0:
 * exactly the figure as before.
 */
export function payoutWalletOutflow(p: {
  totalAmount: string;
  totalFees: string;
  totalPayoutFees?: string | null;
  feesCollectedAtPayment?: string | null;
  net?: string | null;
  manualDeduction?: string | null;
}): string {
  const credited = toCents(orderWalletCredit({ total: p.totalAmount, fees: p.totalFees }));
  const required = credited - collectedAtPaymentCents(p);
  const floor =
    p.net != null ? toCents(p.net) + Math.max(0, toCents(p.manualDeduction ?? "0")) : -Infinity;
  return fromCents(Math.max(required, floor));
}

/**
 * What the fee sweep moves at this payout: the platform's cut plus the
 * deduction, minus the transaction fees already collected at payment time
 * (citizenpay/api#277: `payoutFees + manualDeduction − feesCollectedAtPayment`,
 * the last clamped to `payoutFees`, so never below the deduction). 0 means
 * there is nothing to sweep.
 */
export function payoutSweepAmount(p: {
  totalPayoutFees: string;
  manualDeduction: string;
  feesCollectedAtPayment?: string | null;
}): string {
  return fromCents(
    Math.max(
      0,
      toCents(p.totalPayoutFees) + toCents(p.manualDeduction) - collectedAtPaymentCents(p),
    ),
  );
}

/**
 * The platform fee a fund's configured rate implies for a gross amount —
 * the editable suggestion the manual-order dialog prefills. `percent` is a
 * decimal-percent string ("2.5" = 2.5%); a missing/invalid rate suggests 0.
 */
export function suggestPayoutFee(
  total: string,
  percent: string | null | undefined,
): string {
  const rate = Number(percent ?? 0);
  if (!Number.isFinite(rate) || rate <= 0) return "0.00";
  return fromCents(Math.round((toCents(total) * rate) / 100));
}
