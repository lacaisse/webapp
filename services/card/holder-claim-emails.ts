// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { prisma } from "@/services/db/prisma";
import { sendCardClaimedFromWallet } from "@/services/email/transactional";
import { getFundUrl } from "@/services/fund/host";
import { staffRecipients } from "@/services/fund-team/staff-recipients";

import type { PinBlockEmailFund } from "./pin-block-emails";

// The notification a wallet claim sends (plan "Bread card-holder voting",
// PR W-2): when Citizen Pay attaches one of the fund's cards to a member's
// login on its own proof (`card.attached` with `app`, `bound` or `payment`,
// services/card/holder-claims.ts), the fund's OWNER/ADMIN staff get
// CARD_CLAIMED_FROM_WALLET — the same recipients as the PIN block email
// (services/fund-team/staff-recipients.ts) — with the card page where an
// admin can detach a claim that is not right. The fund's own confirmation
// sends nothing: staff did it themselves.
//
// The Email rows are linked to the card, not to the member: `Email.memberId`
// is the RECIPIENT link, and setting it on a staff email would render it in
// the member's language with the member's unsubscribe link. Idempotent per
// api event (the key carries the event id), so a redelivery never mails
// anyone twice. Never throws: a failed send is logged on its row, a failed
// lookup in the console.

export type HolderClaimEmailFund = PinBlockEmailFund;

export async function sendCardClaimedFromWalletEmails(args: {
  fund: HolderClaimEmailFund;
  card: { id: string; serialNumber: string; holderName: string | null };
  member: { firstName: string; lastName: string } | null;
  eventId: string;
  proof: string | null;
  claimedAt: Date;
}): Promise<number> {
  const { fund, card } = args;
  const holder =
    (args.member ? `${args.member.firstName} ${args.member.lastName}`.trim() : "") ||
    card.holderName ||
    card.serialNumber;
  const branding = {
    name: fund.name,
    primaryColor: fund.primaryColor,
    logoUrl: fund.logoUrl,
  };

  let sent = 0;
  try {
    const recipients = await staffRecipients(fund.id);
    for (const to of recipients) {
      const emailId = await queueEmail({
        fundId: fund.id,
        type: "CARD_CLAIMED_FROM_WALLET",
        toEmail: to,
        cardId: card.id,
        memberId: null,
        idempotencyKey: `CARD_CLAIMED_FROM_WALLET:card:${card.id}:event:${args.eventId}:to:${to.toLowerCase()}`,
      });
      if (!emailId) continue; // already queued for this event
      await sendCardClaimedFromWallet({
        emailId,
        fundId: fund.id,
        toEmail: to,
        fund: branding,
        serial: card.serialNumber,
        holder,
        proof: args.proof,
        claimedAt: args.claimedAt.toISOString(),
        timeZone: fund.timezone,
        cardUrl: `${getFundUrl(fund.domain)}/cards/${card.id}`,
      });
      sent += 1;
    }
  } catch (e) {
    console.error("[card.holder-claims] staff emails failed", card.id, e);
  }
  return sent;
}

// Queue the Email row, or answer null when its idempotency key is already on
// file (a redelivery of the same event). The subject placeholder is replaced
// by the rendered one when the send lands (dispatchTemplate).
async function queueEmail(data: {
  fundId: string;
  type: "CARD_CLAIMED_FROM_WALLET";
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
