// SPDX-License-Identifier: AGPL-3.0-or-later

// Pure decision logic for turning a resolved Card row into a Match (or a
// fall-through). No DB access — match.ts does the Prisma lookup and hands the
// result here. Tested in resolve.test.ts.

import type { MemberStatus } from "@/services/db/generated/enums";

export type BankMatchMethod =
  | "SERIAL"
  | "STRUCTURED_COMMUNICATION"
  | "IBAN"
  | "MANUAL";

export type Match = {
  memberId: string;
  // Member status gates allocation: only ACTIVE members get an auto-mint.
  status: MemberStatus;
  tierId: string | null;
  // The card account to mint to: the referenced card for SERIAL/OGM (falling
  // back to the member's primary if that card has no on-chain account yet),
  // or the member's primary card for IBAN / a SERIAL-OGM match that resolved
  // through a former holder (see matchFromCard).
  account: string | null;
  // The referenced card for a SERIAL/OGM match that's still member-held;
  // null for IBAN and for a SERIAL/OGM match resolved via `formerMember`.
  cardId: string | null;
  method: BankMatchMethod;
};

type MatchedMember = {
  id: string;
  status: MemberStatus;
  tierId: string | null;
  primaryCard: { account: string | null } | null;
};

export type MatchableCard = {
  id: string;
  account: string | null;
  member: MatchedMember | null;
  // The member who last held this card, if it's since been unassigned (see
  // Card.formerMemberId). Lets a stale reference (issue #222 — a member kept
  // writing an old, replaced card's serial on transfers) still resolve.
  formerMember: MatchedMember | null;
};

export function matchFromCard(
  card: MatchableCard,
  method: "SERIAL" | "STRUCTURED_COMMUNICATION",
): Match | null {
  if (card.member) {
    return {
      memberId: card.member.id,
      status: card.member.status,
      tierId: card.member.tierId,
      account: card.account ?? card.member.primaryCard?.account ?? null,
      cardId: card.id,
      method,
    };
  }
  // Unattached card — a lost/replaced card still gets referenced on
  // transfers long after being unassigned. If we know who last held it,
  // resolve to THEM and mint to their current primary card (never the
  // orphaned card's own account, which may be blocked or gone stale).
  if (card.formerMember) {
    return {
      memberId: card.formerMember.id,
      status: card.formerMember.status,
      tierId: card.formerMember.tierId,
      account: card.formerMember.primaryCard?.account ?? null,
      cardId: null,
      method,
    };
  }
  return null;
}
