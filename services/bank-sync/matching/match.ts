// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import type { BankTransactionPayload } from "@/services/citizenpay/types";
import { prisma } from "@/services/db/prisma";

import { parseCardSerial, parseStructuredCommunication } from "./parse";
import { matchFromCard, type Match, type MatchableCard } from "./resolve";

export type { BankMatchMethod, Match } from "./resolve";

// Match an INCOMING deposit to a member. Precedence (fall through on a miss):
//
//   1. SERIAL                  — card NFC serial in the reference → card → member
//   2. STRUCTURED_COMMUNICATION — Belgian OGM, base = card number → card → member
//   3. IBAN                    — counterpart IBAN already learned for a member
//   4. (nothing)               — return null → manual attribution queue
//
// 1 & 2 are definite and resolve a SPECIFIC card (the mint target). 3 is the
// auto fallback and only resolves the member (mint goes to their primary card).
// NAME matching is deliberately absent here — it never auto-matches; it only
// ranks suggestions in the review UI.
//
// 1 & 2 also handle a card that resolved but has no CURRENT owner (issue
// #222): members keep writing an old card's serial/OGM on transfers well
// after it was unassigned (e.g. lost card replaced). In that case we follow
// `Card.formerMemberId` to the member who last held it and mint goes to
// THEIR current primary card, not the stale card's own account — see
// `matchFromCard` in ./resolve.ts.

// What we need off a resolved card to build a Match.
const memberMatchSelect = {
  id: true,
  status: true,
  tierId: true,
  primaryCard: { select: { account: true } },
} as const;

const cardSelect = {
  id: true,
  account: true,
  member: { select: memberMatchSelect },
  formerMember: { select: memberMatchSelect },
} satisfies Record<string, unknown>;

export async function matchMember(
  fundId: string,
  payload: BankTransactionPayload,
): Promise<Match | null> {
  const refs = [payload.counterpartReference, payload.remittanceInfo];

  // 1. Serial → card.
  const serial = parseCardSerial(...refs);
  if (serial) {
    const card: MatchableCard | null = await prisma.card.findFirst({
      where: { fundId, serialNumber: { equals: serial, mode: "insensitive" } },
      select: cardSelect,
    });
    const m = card && matchFromCard(card, "SERIAL");
    if (m) return m;
  }

  // 2. Structured communication → card number → card.
  const cardNumber = parseStructuredCommunication(...refs);
  if (cardNumber != null) {
    const card: MatchableCard | null = await prisma.card.findFirst({
      where: { fundId, number: cardNumber },
      select: cardSelect,
    });
    const m = card && matchFromCard(card, "STRUCTURED_COMMUNICATION");
    if (m) return m;
  }

  // 3. IBAN → learned member mapping (auto, no confirmation).
  if (payload.counterpartIban) {
    const link = await prisma.linkedBankAccount.findUnique({
      where: { fundId_iban: { fundId, iban: payload.counterpartIban } },
      select: {
        member: {
          select: {
            id: true,
            status: true,
            tierId: true,
            primaryCard: { select: { account: true } },
          },
        },
      },
    });
    if (link) {
      return {
        memberId: link.member.id,
        status: link.member.status,
        tierId: link.member.tierId,
        account: link.member.primaryCard?.account ?? null,
        cardId: null,
        method: "IBAN",
      };
    }
  }

  // 4. Nothing resolved — leave for manual attribution.
  return null;
}
