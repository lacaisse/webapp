// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";

import { requireFundRole } from "@/services/auth/dal";
import { resolveTreasurySlug } from "@/services/citizenpay/treasury-slug";
import { prisma } from "@/services/db/prisma";
import { buildCardLink, formatMemberAddress } from "@/services/email/templates";
import { sendCardAssigned } from "@/services/email/transactional";

// Manual "your card is on its way" notification, driven from the card detail
// page. There's no automatic trigger — an admin sends it by hand once the card
// is assigned to a member, and the page surfaces whether it has already gone
// out (the linked Email row's status).
//
// One Email row per (card, member) — keyed so re-assigning a card to a
// different holder gets its own notification. This is a manual, confirm-gated
// admin action, so a repeat click is an explicit "send again": we reuse the
// existing row, re-queue it, and send afresh (no alreadySent short-circuit).

export type NotifyCardResult = { ok: true } | { error: string };

export async function notifyCardAssignedAction(input: {
  cardId: string;
}): Promise<NotifyCardResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const card = await prisma.card.findFirst({
    where: { id: input.cardId, fundId: fund.id },
    select: {
      id: true,
      serialNumber: true,
      number: true,
      memberId: true,
      member: {
        select: {
          email: true,
          firstName: true,
          lastName: true,
          address: true,
          postalCode: true,
          city: true,
        },
      },
    },
  });
  if (!card) return { error: t("cards.admin.notify.errors.notFound" as never) };
  if (!card.memberId || !card.member) {
    return { error: t("cards.admin.notify.errors.noMember" as never) };
  }
  if (!card.member.email) {
    return { error: t("cards.admin.notify.errors.noEmail" as never) };
  }

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
    if ((e as { code?: string }).code !== "P2002") {
      console.error("[notify] failed to queue card-assigned email", card.id, e);
      return { error: t("cards.admin.notify.errors.sendFailed" as never) };
    }
    // Row already exists for this (card, member) — reuse it and (re)send. Reset
    // it to QUEUED so a prior SENT/FAILED row is sent afresh; dispatchTemplate
    // stamps sentAt again on success.
    const existing = await prisma.email.findUnique({
      where: { idempotencyKey },
      select: { id: true },
    });
    if (!existing) {
      return { error: t("cards.admin.notify.errors.sendFailed" as never) };
    }
    await prisma.email.update({
      where: { id: existing.id },
      data: {
        status: "QUEUED",
        errorMessage: null,
        failedAt: null,
        sentAt: null,
      },
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
    firstName: card.member.firstName,
    lastName: card.member.lastName,
    address: formatMemberAddress(card.member),
    cardLink: buildCardLink(
      card.serialNumber,
      await resolveTreasurySlug(fund),
    ),
    cardNumber: card.number != null ? String(card.number) : "",
  });

  // sendCardAssigned swallows errors and marks the row FAILED — read back the
  // outcome so the admin gets accurate feedback.
  const after = await prisma.email.findUnique({
    where: { id: emailId },
    select: { status: true },
  });

  revalidatePath("/cards");
  revalidatePath(`/cards/${card.id}`);
  if (after?.status === "SENT") return { ok: true };
  return { error: t("cards.admin.notify.errors.sendFailed" as never) };
}
