// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import type { BankTransactionPayload } from "@/services/citizenpay/types";
import type { MemberStatus } from "@/services/db/generated/enums";
import { prisma } from "@/services/db/prisma";

import { parseCardSerial, parseStructuredCommunication } from "./parse";

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
  // or the member's primary card for IBAN.
  account: string | null;
  // The referenced card for SERIAL/OGM matches; null for IBAN.
  cardId: string | null;
  method: BankMatchMethod;
};

// What we need off a resolved card to build a Match.
const cardSelect = {
  id: true,
  account: true,
  member: {
    select: {
      id: true,
      status: true,
      tierId: true,
      primaryCard: { select: { account: true } },
    },
  },
} as const;

function matchFromCard(
  card: {
    id: string;
    account: string | null;
    member: {
      id: string;
      status: MemberStatus;
      tierId: string | null;
      primaryCard: { account: string | null } | null;
    } | null;
  },
  method: "SERIAL" | "STRUCTURED_COMMUNICATION",
): Match | null {
  // An unattached card (no member) can't drive an allocation — fall through.
  if (!card.member) return null;
  return {
    memberId: card.member.id,
    status: card.member.status,
    tierId: card.member.tierId,
    account: card.account ?? card.member.primaryCard?.account ?? null,
    cardId: card.id,
    method,
  };
}

export async function matchMember(
  fundId: string,
  payload: BankTransactionPayload,
): Promise<Match | null> {
  const refs = [payload.counterpartReference, payload.remittanceInfo];

  // 1. Serial → card.
  const serial = parseCardSerial(...refs);
  if (serial) {
    const card = await prisma.card.findFirst({
      where: { fundId, serialNumber: { equals: serial, mode: "insensitive" } },
      select: cardSelect,
    });
    const m = card && matchFromCard(card, "SERIAL");
    if (m) return m;
  }

  // 2. Structured communication → card number → card.
  const cardNumber = parseStructuredCommunication(...refs);
  if (cardNumber != null) {
    const card = await prisma.card.findFirst({
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
