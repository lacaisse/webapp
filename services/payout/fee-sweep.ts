// SPDX-License-Identifier: AGPL-3.0-or-later

// The payout fee sweep's answers since citizenpay/api#277 (transaction fees
// sent to the fund's fee account at payment time), kept pure so the
// operations engine, the payout page and the MCP tools read them alike.
//
// Two answers are NOT failures:
//   • 409 "transaction fees of this payout are still settling, retry
//     shortly" (on fee-transfer, and as the burn report's feeTransferError
//     with feeTransferPending: true): a fee leg of one of the payout's orders
//     is still in flight. Normally seconds; the api bounds it at about 49 h.
//     Keep the payout where it is and retry later.
//   • 422 "payout has no fees or manual deduction to transfer" (on
//     fee-transfer, and as the burn report's feeTransferError with
//     feeTransferPending: false): every fee was already collected at payment
//     time and there is no deduction, so nothing is left to sweep. Done.
// Matched on the api's words (stable texts in its handler); the status code
// says which family it is.

const FEES_SETTLING = /still settling/i;
const NOTHING_TO_SWEEP = /no fees or manual deduction to transfer/i;

export function isFeesSettlingMessage(message: string | null | undefined): boolean {
  return typeof message === "string" && FEES_SETTLING.test(message);
}

export function isNothingToSweepMessage(message: string | null | undefined): boolean {
  return typeof message === "string" && NOTHING_TO_SWEEP.test(message);
}

// Automatic retries of a sweep that answered "still settling", while the
// payout page (or the burn dialog) is open: 5 s, 10 s, 20 s, … capped at
// 5 min, at most FEE_SETTLING_MAX_ATTEMPTS tries (about 40 minutes in all).
// After that the operator retries by hand; nothing is lost by waiting, the
// api keeps the cut in the place's account until a sweep runs.
export const FEE_SETTLING_MAX_ATTEMPTS = 12;
const FEE_SETTLING_BASE_MS = 5_000;
const FEE_SETTLING_CAP_MS = 5 * 60_000;

/** Delay before automatic retry number `attempt` (1-based); null = stop. */
export function feeSettlingRetryDelayMs(attempt: number): number | null {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > FEE_SETTLING_MAX_ATTEMPTS) {
    return null;
  }
  return Math.min(FEE_SETTLING_BASE_MS * 2 ** (attempt - 1), FEE_SETTLING_CAP_MS);
}
