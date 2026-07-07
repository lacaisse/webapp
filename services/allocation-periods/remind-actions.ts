// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";

import { requireFundRole } from "@/services/auth/dal";
import { Prisma } from "@/services/db/generated/client";
import { prisma } from "@/services/db/prisma";
import { buildCardLink } from "@/services/email/templates";
import { sendPaymentReminder } from "@/services/email/transactional";
import { resolveRequestedContribution } from "@/services/member/contribution";
import { REMINDER_ELIGIBLE_STATUS } from "@/services/member/eligibility";

// Manual "remind the unpaid members" action, driven from the period detail
// page's Missing tab (issue #34, on top of the #18 unpaid report). The monthly
// cron (services/member/reminders.ts) sends the automatic first request
// (PAYMENT_REMINDER_FIRST) on the 1st; this is the admin's manual follow-up
// nudge, recorded as PAYMENT_REMINDER_SECOND so:
//   - it can be sent even after the cron already sent the first reminder, and
//   - it has its own idempotency key, so re-clicking "remind all" is safe
//     (a second SENT row is never created for the same period + member).
//
// Eligibility mirrors the cron's exclusions AND the Missing-tab definition: an
// ACTIVE member with a tier and a primary card who has no INCOMING deposit
// attributed to this period. On top of that, sending also requires an email
// address and that the member hasn't opted out of reminders — members who fail
// those last two stay on the unpaid report but are skipped (and surfaced) here.

const FUND_SELECT = {
  id: true,
  name: true,
  primaryColor: true,
  logoUrl: true,
  senderEmail: true,
  citizenPayTreasurySlug: true,
} satisfies Prisma.FundSelect;

const MEMBER_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  paymentReference: true,
  contributionAmount: true,
  tier: { select: { allocationAmount: true } },
  primaryCard: { select: { serialNumber: true } },
} satisfies Prisma.MemberSelect;

type FundForReminder = Prisma.FundGetPayload<{ select: typeof FUND_SELECT }>;
type MemberForReminder = Prisma.MemberGetPayload<{ select: typeof MEMBER_SELECT }>;

// Whether a member is currently unpaid + sendable for the given period. Applied
// as query filters so we never queue an Email row for an excluded member, and
// re-checked server-side for the single-member action (don't trust the client).
function unpaidSendableWhere(fundId: string, periodId: string) {
  return {
    fundId,
    status: REMINDER_ELIGIBLE_STATUS,
    emailUnsubscribed: false,
    tierId: { not: null },
    primaryCardId: { not: null },
    bankTransactions: {
      none: { direction: "INCOMING", allocationPeriodId: periodId },
    },
  } satisfies Prisma.MemberWhereInput;
}

type SingleStatus = "sent" | "alreadySent" | "failed";

export type RemindMemberResult =
  | { ok: true; status: SingleStatus }
  | { error: string };

export async function remindUnpaidMemberAction(input: {
  periodId: string;
  memberId: string;
}): Promise<RemindMemberResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const period = await prisma.allocationPeriod.findFirst({
    where: { id: input.periodId, fundId: fund.id },
    select: { id: true, label: true, fund: { select: FUND_SELECT } },
  });
  if (!period) {
    return { error: t("periods.errors.notFound" as never) };
  }

  const member = await prisma.member.findFirst({
    where: { ...unpaidSendableWhere(fund.id, period.id), id: input.memberId },
    select: MEMBER_SELECT,
  });
  if (!member) {
    return {
      error: t(
        "fund.allocations.periodDetail.remind.errors.notRemindable" as never,
      ),
    };
  }
  if (!member.email) {
    return {
      error: t("fund.allocations.periodDetail.remind.errors.noEmail" as never),
    };
  }

  const status = await remindOne(period.fund, period, member);
  revalidatePath(`/allocations/periods/${period.id}`);
  if (status === "failed") {
    return {
      error: t(
        "fund.allocations.periodDetail.remind.errors.sendFailed" as never,
      ),
    };
  }
  return { ok: true, status };
}

export type RemindPeriodResult =
  | { ok: true; sent: number; skipped: number; failed: number }
  | { error: string };

export async function remindPeriodUnpaidAction(input: {
  periodId: string;
}): Promise<RemindPeriodResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const period = await prisma.allocationPeriod.findFirst({
    where: { id: input.periodId, fundId: fund.id },
    select: { id: true, label: true, fund: { select: FUND_SELECT } },
  });
  if (!period) {
    return { error: t("periods.errors.notFound" as never) };
  }

  const members = await prisma.member.findMany({
    where: { ...unpaidSendableWhere(fund.id, period.id), email: { not: "" } },
    select: MEMBER_SELECT,
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const member of members) {
    const status = await remindOne(period.fund, period, member);
    if (status === "sent") sent++;
    else if (status === "alreadySent") skipped++;
    else failed++;
  }

  revalidatePath(`/allocations/periods/${period.id}`);
  return { ok: true, sent, skipped, failed };
}

// Queue + send one PAYMENT_REMINDER_SECOND, idempotent per (period, member).
// Mirrors services/member/reminders.ts::remindOne and the notify-actions send
// path: P2002 on the idempotency key means a row already exists — SENT → skip,
// otherwise reuse the row and retry.
async function remindOne(
  fund: FundForReminder,
  period: { id: string; label: string },
  member: MemberForReminder,
): Promise<SingleStatus> {
  if (!member.email) return "failed";
  const idempotencyKey = `PAYMENT_REMINDER_SECOND:period:${period.id}:member:${member.id}`;

  let emailId: string;
  try {
    const row = await prisma.email.create({
      data: {
        fundId: fund.id,
        type: "PAYMENT_REMINDER_SECOND",
        toEmail: member.email,
        memberId: member.id,
        allocationPeriodId: period.id,
        idempotencyKey,
        subject: "Payment reminder",
      },
      select: { id: true },
    });
    emailId = row.id;
  } catch (e) {
    if ((e as { code?: string }).code !== "P2002") {
      console.error("[remind] queue failed", member.id, e);
      return "failed";
    }
    const existing = await prisma.email.findUnique({
      where: { idempotencyKey },
      select: { id: true, status: true },
    });
    if (!existing) return "failed";
    if (existing.status === "SENT") return "alreadySent";
    await prisma.email.update({
      where: { id: existing.id },
      data: { status: "QUEUED", errorMessage: null, failedAt: null },
    });
    emailId = existing.id;
  }

  const cardLink = member.primaryCard
    ? buildCardLink(member.primaryCard.serialNumber, fund.citizenPayTreasurySlug)
    : "";

  await sendPaymentReminder({
    emailId,
    fundId: fund.id,
    toEmail: member.email,
    fund: {
      name: fund.name,
      primaryColor: fund.primaryColor,
      logoUrl: fund.logoUrl,
      senderEmail: fund.senderEmail,
    },
    firstName: member.firstName,
    lastName: member.lastName,
    amount: resolveRequestedContribution(
      member.contributionAmount,
      member.tier?.allocationAmount,
    ),
    paymentReference: member.paymentReference ?? "",
    cardLink,
  });

  const after = await prisma.email.findUnique({
    where: { id: emailId },
    select: { status: true },
  });
  return after?.status === "SENT" ? "sent" : "failed";
}
