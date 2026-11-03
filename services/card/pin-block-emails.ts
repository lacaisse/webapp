// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import type { FundCredentials } from "@/services/citizenpay/client";
import { prisma } from "@/services/db/prisma";
import {
  sendCardPinBlocked,
  sendCardPinBlockedHolder,
} from "@/services/email/transactional";
import { getFundUrl } from "@/services/fund/host";

// The two notifications a PIN block sends (D12), both through the queued
// Email rows of services/email/transactional.ts and both linked to the card
// (Card.emails): CARD_PIN_BLOCKED to the fund's OWNER/ADMIN staff — the
// recipients `notifyIssuerStaff` (enrollment requests) uses — and
// CARD_PIN_BLOCKED_HOLDER to the bound member when they have an email, with
// a link to the card wallet where they can set a new PIN to unblock the card
// themselves. Idempotent per api event: the Email rows are keyed on the event
// id, so a redelivery (or a second webhook for the same block) never mails
// anyone twice. Never throws: a failed send is logged on the row.

export type PinBlockEmailFund = FundCredentials & {
  name: string;
  domain: string;
  primaryColor: string | null;
  logoUrl: string | null;
  senderEmail: string | null;
  citizenPayTreasurySlug: string | null;
  timezone: string;
};

export type PinBlockEmailCard = {
  id: string;
  serialNumber: string;
  number: number | null;
  holderName: string | null;
  memberId: string | null;
  member: { firstName: string; lastName: string; email: string | null } | null;
};

// The card wallet's page for a card (tap.citizenpay.eu): where the holder
// sees the block and sets a new PIN. The treasury slug is a hint the wallet
// accepts; the serial alone resolves the card.
export const CARD_WALLET_BASE_URL = "https://tap.citizenpay.eu";

export function walletCardUrl(serial: string, slug: string | null): string {
  const base = `${CARD_WALLET_BASE_URL}/card/${encodeURIComponent(serial)}`;
  return slug ? `${base}?network=${encodeURIComponent(slug)}` : base;
}

export async function sendCardPinBlockedEmails(args: {
  fund: PinBlockEmailFund;
  card: PinBlockEmailCard;
  eventId: string;
  placeName: string | null;
  blockedAt: Date;
}): Promise<{ staff: number; holder: boolean }> {
  const { fund, card } = args;
  const holder =
    card.holderName ||
    (card.member ? `${card.member.firstName} ${card.member.lastName}`.trim() : "") ||
    card.serialNumber;
  const branding = {
    name: fund.name,
    primaryColor: fund.primaryColor,
    logoUrl: fund.logoUrl,
  };
  const blockedAt = args.blockedAt.toISOString();
  const place = args.placeName ?? "";

  let staff = 0;
  try {
    const recipients = await staffRecipients(fund.id);
    for (const to of recipients) {
      const emailId = await queueEmail({
        fundId: fund.id,
        type: "CARD_PIN_BLOCKED",
        toEmail: to,
        cardId: card.id,
        memberId: null,
        idempotencyKey: `CARD_PIN_BLOCKED:card:${card.id}:event:${args.eventId}:to:${to.toLowerCase()}`,
      });
      if (!emailId) continue; // already queued for this event
      await sendCardPinBlocked({
        emailId,
        fundId: fund.id,
        toEmail: to,
        fund: branding,
        serial: card.serialNumber,
        holder,
        place,
        blockedAt,
        timeZone: fund.timezone,
        cardUrl: `${getFundUrl(fund.domain)}/cards/${card.id}`,
      });
      staff += 1;
    }
  } catch (e) {
    console.error("[card.pin-block] staff emails failed", card.id, e);
  }

  let holderSent = false;
  if (card.memberId && card.member?.email) {
    try {
      const emailId = await queueEmail({
        fundId: fund.id,
        type: "CARD_PIN_BLOCKED_HOLDER",
        toEmail: card.member.email,
        cardId: card.id,
        memberId: card.memberId,
        idempotencyKey: `CARD_PIN_BLOCKED_HOLDER:card:${card.id}:event:${args.eventId}`,
      });
      if (emailId) {
        await sendCardPinBlockedHolder({
          emailId,
          fundId: fund.id,
          toEmail: card.member.email,
          fund: { ...branding, senderEmail: fund.senderEmail },
          firstName: card.member.firstName,
          place,
          blockedAt,
          timeZone: fund.timezone,
          walletUrl: walletCardUrl(card.serialNumber, fund.citizenPayTreasurySlug),
        });
        holderSent = true;
      }
    } catch (e) {
      console.error("[card.pin-block] holder email failed", card.id, e);
    }
  }

  return { staff, holder: holderSent };
}

// The fund's OWNER/ADMIN staff emails, deduplicated — the same set
// `notifyIssuerStaff` (services/card/enrollment-requests.ts) mails.
export async function staffRecipients(fundId: string): Promise<string[]> {
  const staff = await prisma.fundMember.findMany({
    where: { fundId, role: { in: ["OWNER", "ADMIN"] } },
    select: { user: { select: { email: true } } },
  });
  return [...new Set(staff.map((s) => s.user.email).filter(Boolean))];
}

// Queue the Email row, or answer null when its idempotency key is already on
// file (a redelivery of the same event). The subject placeholder is replaced
// by the rendered one when the send lands (dispatchTemplate).
async function queueEmail(data: {
  fundId: string;
  type: "CARD_PIN_BLOCKED" | "CARD_PIN_BLOCKED_HOLDER";
  toEmail: string;
  cardId: string;
  memberId: string | null;
  idempotencyKey: string;
}): Promise<string | null> {
  try {
    const row = await prisma.email.create({
      data: { ...data, subject: "Card" },
      select: { id: true },
    });
    return row.id;
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") return null;
    throw e;
  }
}
