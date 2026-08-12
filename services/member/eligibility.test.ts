// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { isMemberDeletable } from "./eligibility";

describe("isMemberDeletable", () => {
  it("is true when there's no card and no transaction history", () => {
    expect(
      isMemberDeletable({ cards: 0, bankTransactions: 0, tokenOperations: 0 }),
    ).toBe(true);
  });

  it("is false when a card is linked", () => {
    expect(
      isMemberDeletable({ cards: 1, bankTransactions: 0, tokenOperations: 0 }),
    ).toBe(false);
  });

  it("is false when there's incoming bank transaction history", () => {
    expect(
      isMemberDeletable({ cards: 0, bankTransactions: 1, tokenOperations: 0 }),
    ).toBe(false);
  });

  it("is false when there's a mint/burn token operation", () => {
    expect(
      isMemberDeletable({ cards: 0, bankTransactions: 0, tokenOperations: 1 }),
    ).toBe(false);
  });
});
