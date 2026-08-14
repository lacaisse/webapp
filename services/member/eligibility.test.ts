// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { isMemberDeletable } from "./eligibility";

// Shorthand: a member with nothing attached, overridable per case.
function member(
  over: Partial<{
    cards: number;
    bankTransactions: number;
    tokenOperations: number;
    sponsoredReferrals: number;
    referralRecord: { id: string } | null;
  }> = {},
) {
  const { referralRecord = null, ...counts } = over;
  return {
    _count: {
      cards: 0,
      bankTransactions: 0,
      tokenOperations: 0,
      sponsoredReferrals: 0,
      ...counts,
    },
    referralRecord,
  };
}

describe("isMemberDeletable", () => {
  it("is true when there's no card, no transaction history and no referral", () => {
    expect(isMemberDeletable(member())).toBe(true);
  });

  it("is false when a card is linked", () => {
    expect(isMemberDeletable(member({ cards: 1 }))).toBe(false);
  });

  it("is false when there's incoming bank transaction history", () => {
    expect(isMemberDeletable(member({ bankTransactions: 1 }))).toBe(false);
  });

  it("is false when there's a mint/burn token operation", () => {
    expect(isMemberDeletable(member({ tokenOperations: 1 }))).toBe(false);
  });

  // Referral rows cascade on delete instead of detaching, so both directions
  // block the irreversible path — see the comment on isMemberDeletable.
  it("is false when the member sponsored someone else", () => {
    expect(isMemberDeletable(member({ sponsoredReferrals: 1 }))).toBe(false);
  });

  it("is false when the member was themselves referred", () => {
    expect(isMemberDeletable(member({ referralRecord: { id: "r1" } }))).toBe(
      false,
    );
  });
});
