// SPDX-License-Identifier: AGPL-3.0-or-later

// Pure holder-name rules, shared by the card-sync push, the CitizenPay
// holder-name publish (services/card/publish-holder-name.ts) and the one-off
// backfill script (scripts/sync-holder-names.ts — which is why this module
// stays free of `server-only` / Prisma imports).

export type HolderNameMember = { firstName: string; lastName: string };

/**
 * The name a card is held under: the card's own `holderName` when set (it is
 * stamped at assignment, and can differ from the member for a dependant's
 * card), else the member's "firstName lastName", else null.
 */
export function holderDisplayName(
  member: HolderNameMember | null,
  holderName: string | null,
): string | null {
  const own = holderName?.trim();
  if (own) return own;
  if (!member) return null;
  return `${member.firstName} ${member.lastName}`.trim() || null;
}

/**
 * The name to publish to CitizenPay for a card. An unassigned card publishes
 * null (CP resets it to `Card <serial>`): `unassignCardAction` keeps the
 * outgoing holder's `holderName` on the row, and that name must not stay on
 * the public wallet of a retired / re-issued card.
 */
export function publishedHolderName(card: {
  memberId: string | null;
  holderName: string | null;
  member: HolderNameMember | null;
}): string | null {
  if (!card.memberId) return null;
  return holderDisplayName(card.member, card.holderName);
}

export type BackfillDecision =
  | { kind: "publish"; name: string }
  | { kind: "noName" }
  | { kind: "stale"; holderName: string; memberName: string };

/**
 * What the one-off backfill (scripts/sync-holder-names.ts) does with a card.
 * Renames made before holder names were published never touched
 * `Card.holderName`, and `holderDisplayName` prefers it — so a card whose own
 * name differs from its member's CURRENT name may carry an old (e.g. maiden)
 * name. Those are held back for review instead of published. (A dependant's
 * card legitimately differs too; review tells the two apart.)
 */
export function backfillDecision(card: {
  memberId: string | null;
  holderName: string | null;
  member: HolderNameMember | null;
}): BackfillDecision {
  const name = publishedHolderName(card);
  if (!name) return { kind: "noName" };
  const own = card.holderName?.trim();
  const memberName = card.member
    ? `${card.member.firstName} ${card.member.lastName}`.trim()
    : "";
  if (own && memberName && own !== memberName) {
    return { kind: "stale", holderName: own, memberName };
  }
  return { kind: "publish", name };
}
