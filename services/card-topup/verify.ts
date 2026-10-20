// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PaymentRequestState } from "@/services/citizenpay/types";

// Pure checks between a CardTopUp row and CitizenPay's view of its payment
// request. Tested in settle.test.ts / verify.test.ts.

export type TopUpRef = { amountCents: number; account: string };

/**
 * Does CP's payment request describe THIS top-up? The id reaches us through
 * the browser (the bank redirect), so it is a claim to verify, not proof: the
 * request must belong to this fund's treasury (the money went to its bank
 * account), be a top-up-only one (no order), for exactly this amount and this
 * card's account.
 *
 * A response without `treasuryId` is a mismatch: until CP api#224 ships it
 * (and 404s another treasury's request), a request signed on another
 * treasury with our card's account and amount would otherwise pass. So
 * nothing is minted from CP's status alone before api#224 is live.
 */
export function paymentRequestMatches(
  topUp: TopUpRef,
  pr: PaymentRequestState,
  treasuryId: string | null,
): boolean {
  if (!treasuryId || pr.treasuryId !== treasuryId) return false;
  if (pr.orderId != null) return false;
  if (pr.amountCents !== topUp.amountCents) return false;
  if (!pr.account) return false;
  return pr.account.toLowerCase() === topUp.account.toLowerCase();
}

export type TopUpOutcome = "pending" | "signed" | "expired" | "cancelled";

/** A CardTopUp's status as the UI sees it (lower-cased enum). */
export type TopUpStatus = "pending" | "signed" | "minted" | "expired" | "cancelled";

/** CP status → what the top-up should do next. */
export function outcomeFor(pr: PaymentRequestState | null): TopUpOutcome {
  if (!pr) return "cancelled"; // CP doesn't know the request
  switch (pr.status) {
    case "signed":
      return "signed";
    case "expired":
      return "expired";
    case "cancelled":
      return "cancelled";
    default:
      return "pending";
  }
}
