// SPDX-License-Identifier: AGPL-3.0-or-later

// Per-member committed contribution amount (issue #82).
//
// A member's `contributionAmount` is what we ASK them to contribute in
// payment-reminder emails. It defaults to their tier's target (`allocationAmount`)
// and can be set to a different value with a floor of the tier's
// `minContribution`. It is purely the *requested* amount — it never changes how
// many tokens are minted (always the tier's `allocationAmount`) nor the
// minimum-hit check that gates an allocation (always the tier's
// `minContribution`). Both of those stay tier-driven; see
// services/allocation-periods/run.ts and services/bank-sync/allocate.ts.
//
// These helpers are pure (no Prisma / server-only) so they can be shared and
// unit-tested. `Money` is the minimal Decimal-ish shape both a Prisma.Decimal
// and a plain number satisfy for our purposes.

export type Money = { toString(): string };

// The tier/commitment concept only exists for FIXED_PERIOD funds that actually
// have tiers. PAY_AND_GO mints per-deposit and DISABLED funds don't allocate,
// so there's no "amount we ask you to contribute each period" to commit to.
// Gates both the UI (signup + admin edit fields, list/detail display) and
// server persistence so a stray value can't be stored where it's meaningless.
export function contributionApplies(
  allocationMode: string,
  tierCount: number,
): boolean {
  return allocationMode === "FIXED_PERIOD" && tierCount > 0;
}

// Resolve what we should request from a member: their explicit committed
// amount, or the tier target when they haven't set one (or have no tier).
// Returns "" when neither is known (tier-less member with no committed amount),
// matching the empty-string contract the reminder email templates expect.
export function resolveRequestedContribution(
  contributionAmount: Money | null | undefined,
  tierAllocationAmount: Money | null | undefined,
): string {
  const source = contributionAmount ?? tierAllocationAmount;
  return source == null ? "" : source.toString();
}

// Whether a committed amount is below the tier's minimum contribution. Used to
// reject an admin/member setting a commitment under the tier floor. A member
// with no tier has no floor, so nothing is below it.
export function isBelowTierMinimum(
  amount: number,
  tierMinContribution: number | null | undefined,
): boolean {
  if (tierMinContribution == null) return false;
  return amount < tierMinContribution;
}
