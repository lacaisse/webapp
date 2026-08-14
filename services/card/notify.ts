// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import type { FundCredentials } from "@/services/citizenpay/client";
import { resolveTreasurySlug } from "@/services/citizenpay/treasury-slug";
import { prisma } from "@/services/db/prisma";
import { buildCardLink, formatMemberAddress } from "@/services/email/templates";
import { sendCardAssigned } from "@/services/email/transactional";

// Fund subset needed to brand + tap-link the CARD_ASSIGNED email. Mirrors the
// shape both the manual notify action and the activation flow already hold from
// requireFundRole().
export type CardAssignedFund = FundCredentials & {
  name: string;
  primaryColor: string | null;
  logoUrl: string | null;
  senderEmail: string | null;
  citizenPayTreasurySlug: string | null;
};

export type CardForNotify = {
  id: string;
  serialNumber: string;
  number: number | null;
  memberId: string;
  member: {
    email: string;
    firstName: string;
    lastName: string;
    address: string | null;
    postalCode: string | null;
    city: string | null;
  };
};

// Queue (or reuse) the per-(card, member) CARD_ASSIGNED Email row, then dispatch
// it through Resend. Returns the final row status. Shared by the manual
// "notify member" action (card detail page) and the activation flow's
// "send card email" option, so the idempotency + re-send semantics live in one
// place.
//
// One Email row per (card, member) — keyed so re-assigning a card to a
// different holder gets its own notification. A repeat call reuses the existing
// row and (re)sends afresh (resets a prior SENT/FAILED row back to QUEUED).
//
// Caller guarantees the card has a member with an email on file. `sendCardAssigned`
// swallows send errors and marks the row FAILED, so this never throws on a send
// failure — only on an unexpected DB error.
export async function dispatchCardAssignedEmail(args: {
  fund: CardAssignedFund;
  card: CardForNotify;
}): Promise<"SENT" | "FAILED"> {
  const { fund, card } = args;
  const idempotencyKey = `CARD_ASSIGNED:card:${card.id}:member:${card.memberId}`;

  let emailId: string;
  try {
    const row = await prisma.email.create({
      data: {
        fundId: fund.id,
        type: "CARD_ASSIGNED",
        toEmail: card.member.email,
        memberId: card.memberId,
        cardId: card.id,
        idempotencyKey,
        subject: "Card",
      },
      select: { id: true },
    });
    emailId = row.id;
  } catch (e) {
    if ((e as { code?: string }).code !== "P2002") throw e;
    // Row already exists for this (card, member) — reuse it and (re)send. Reset
    // it to QUEUED so a prior SENT/FAILED row is sent afresh; dispatchTemplate
    // stamps sentAt again on success.
    const existing = await prisma.email.findUnique({
      where: { idempotencyKey },
      select: { id: true },
    });
    if (!existing) throw e;
    await prisma.email.update({
      where: { id: existing.id },
      data: { status: "QUEUED", errorMessage: null, failedAt: null, sentAt: null },
    });
    emailId = existing.id;
  }

  await sendCardAssigned({
    emailId,
    fundId: fund.id,
    toEmail: card.member.email,
    fund: {
      name: fund.name,
      primaryColor: fund.primaryColor,
      logoUrl: fund.logoUrl,
      senderEmail: fund.senderEmail,
    },
    // Only used (lazily) if the active template references {iban} — see
    // resolveCardAssignedTemplate.
    citizenPay: fund,
    firstName: card.member.firstName,
    lastName: card.member.lastName,
    address: formatMemberAddress(card.member),
    cardLink: buildCardLink(card.serialNumber, await resolveTreasurySlug(fund)),
    cardNumber: card.number != null ? String(card.number) : "",
    // The bank-transfer reference is the card's serial — the same value
    // bank-sync matches deposits on (see services/member/reminders.ts).
    paymentReference: card.serialNumber,
  });

  // sendCardAssigned swallows errors and marks the row FAILED — read back the
  // outcome so the caller gets an accurate result.
  const after = await prisma.email.findUnique({
    where: { id: emailId },
    select: { status: true },
  });
  return after?.status === "SENT" ? "SENT" : "FAILED";
}
