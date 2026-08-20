// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";

import { requireFundRole } from "@/services/auth/dal";
import { resolveTreasurySlug } from "@/services/citizenpay/treasury-slug";
import { prisma } from "@/services/db/prisma";
import { buildCardLink } from "@/services/email/templates";
import { sendMemberPaymentLink } from "@/services/email/transactional";
import { buildPaymentPageUrl } from "@/services/payment/pay-link";

// On-request payment-link email (issue #45): a member asks — by phone, in
// person, by mail — for their payment link or account page again, and an admin
// sends it from the member detail page. There is deliberately no automatic
// trigger; this is the manual counterpart to the reminder cron.
//
// One Email row per member, re-queued on each send rather than one row per
// click: the member is asking for the same thing each time, so the page shows
// "last sent" rather than accumulating a row per request. Mirrors
// notifyCardAssignedAction, where a repeat click is an explicit "send again".

export type SendPaymentLinkResult = { ok: true } | { error: string };

export async function sendMemberPaymentLinkAction(input: {
  memberId: string;
}): Promise<SendPaymentLinkResult> {
  const t = await getTranslations();
  // Member management is OPERATOR+, same floor as the other member actions.
  const { fund } = await requireFundRole("OPERATOR");

  const member = await prisma.member.findFirst({
    where: { id: input.memberId, fundId: fund.id },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      primaryCard: { select: { serialNumber: true } },
    },
  });
  if (!member) return { error: t("members.admin.errors.notFound" as never) };
  if (!member.email) {
    return { error: t("members.admin.paymentLink.errors.noEmail" as never) };
  }
  // Both links are keyed on the card serial, so there's nothing to send to a
  // member who hasn't been given a card yet.
  if (!member.primaryCard) {
    return { error: t("members.admin.paymentLink.errors.noCard" as never) };
  }

  const serial = member.primaryCard.serialNumber;
  const idempotencyKey = `MEMBER_PAYMENT_LINK:member:${member.id}`;

  let emailId: string;
  try {
    const row = await prisma.email.create({
      data: {
        fundId: fund.id,
        type: "MEMBER_PAYMENT_LINK",
        toEmail: member.email,
        memberId: member.id,
        idempotencyKey,
        subject: "Payment link",
      },
      select: { id: true },
    });
    emailId = row.id;
  } catch (e) {
    if ((e as { code?: string }).code !== "P2002") throw e;
    // Already sent once — reuse the row and send afresh, resetting a prior
    // SENT/FAILED back to QUEUED so dispatchTemplate stamps it again.
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

  try {
    await sendMemberPaymentLink({
      emailId,
      fundId: fund.id,
      toEmail: member.email,
      firstName: member.firstName,
      lastName: member.lastName,
      fund: {
        name: fund.name,
        primaryColor: fund.primaryColor,
        logoUrl: fund.logoUrl,
        senderEmail: fund.senderEmail,
      },
      // The bank-transfer reference is the card serial, the same value
      // bank-sync matches deposits on.
      paymentReference: serial,
      paymentLink: buildPaymentPageUrl(fund.domain, serial),
      cardLink: buildCardLink(serial, await resolveTreasurySlug(fund)),
    });
  } catch (e) {
    console.error("[member] payment-link email failed", member.id, e);
    return { error: t("members.admin.paymentLink.errors.sendFailed" as never) };
  }

  // sendMemberPaymentLink swallows send errors and marks the row FAILED — read
  // back the outcome so the admin is told the truth about what happened.
  const after = await prisma.email.findUnique({
    where: { id: emailId },
    select: { status: true },
  });
  revalidatePath(`/members/${member.id}`);
  if (after?.status !== "SENT") {
    return { error: t("members.admin.paymentLink.errors.sendFailed" as never) };
  }
  return { ok: true };
}
