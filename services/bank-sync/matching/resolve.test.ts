// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from "vitest";

import { matchFromCard, type MatchableCard } from "./resolve";

const member: MatchableCard["member"] = {
  id: "member-1",
  status: "ACTIVE",
  tierId: "tier-1",
  primaryCard: { account: "0xprimary" },
};

describe("matchFromCard", () => {
  it("matches a currently-held card to its member and card account", () => {
    const card: MatchableCard = {
      id: "card-1",
      account: "0xcard",
      member,
      formerMember: null,
    };
    expect(matchFromCard(card, "SERIAL")).toEqual({
      memberId: "member-1",
      status: "ACTIVE",
      tierId: "tier-1",
      account: "0xcard",
      cardId: "card-1",
      method: "SERIAL",
    });
  });

  it("falls back to the member's primary card when the held card has no account yet", () => {
    const card: MatchableCard = {
      id: "card-1",
      account: null,
      member,
      formerMember: null,
    };
    expect(matchFromCard(card, "SERIAL")?.account).toBe("0xprimary");
  });

  // issue #222: Sonia kept writing her old card's serial after getting a
  // replacement — the old card is unassigned (member: null) but still
  // remembers her via formerMember.
  it("resolves an unassigned card via its former member's current primary card", () => {
    const card: MatchableCard = {
      id: "old-card",
      account: "0xold-card-stale",
      member: null,
      formerMember: member,
    };
    expect(matchFromCard(card, "SERIAL")).toEqual({
      memberId: "member-1",
      status: "ACTIVE",
      tierId: "tier-1",
      account: "0xprimary", // the CURRENT primary card, never the stale old card
      cardId: null,
      method: "SERIAL",
    });
  });

  it("still resolves the member with a null account when they have no primary card yet", () => {
    const card: MatchableCard = {
      id: "old-card",
      account: "0xold-card-stale",
      member: null,
      formerMember: { ...member, primaryCard: null },
    };
    expect(matchFromCard(card, "SERIAL")).toEqual({
      memberId: "member-1",
      status: "ACTIVE",
      tierId: "tier-1",
      account: null,
      cardId: null,
      method: "SERIAL",
    });
  });

  it("falls through to null when the card has never had a member on record", () => {
    const card: MatchableCard = {
      id: "unattached",
      account: null,
      member: null,
      formerMember: null,
    };
    expect(matchFromCard(card, "STRUCTURED_COMMUNICATION")).toBeNull();
  });
});
