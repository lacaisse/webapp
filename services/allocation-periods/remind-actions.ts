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
import { buildPaymentPageUrl } from "@/services/payment/pay-link";
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
//
// The fund-wide member-email pause (Fund.confirmationEmailsPausedAt) does not
// silently apply here: a paused fund makes these actions return
// `pausedConfirmRequired` instead of sending, and the caller re-invokes with
// `overridePause: true` once the admin has confirmed in a modal. So the pause is
// never bypassed by accident (unlike before, when reminders ignored it entirely)
// and never silently swallows an explicit admin click either. The automatic
// monthly cron (services/member/reminders.ts) has no such escape hatch — it
// skips paused funds outright.

const FUND_SELECT = {
  id: true,
  name: true,
  primaryColor: true,
  logoUrl: true,
  senderEmail: true,
  // Canonical host — used to build the public /pay/<serial> {paymentLink}.
  domain: true,
  citizenPayTreasurySlug: true,
  // Fund-wide member-email pause; blocks the manual reminder (see above).
  confirmationEmailsPausedAt: true,
} satisfies Prisma.FundSelect;

const MEMBER_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
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

// Returned when member emails are paused and the admin hasn't confirmed the
// override yet. The client shows a modal and re-calls with overridePause: true.
export type PausedConfirmRequired = { pausedConfirmRequired: true };

export type RemindMemberResult =
  | { ok: true; status: SingleStatus }
  | PausedConfirmRequired
  | { error: string };

export async function remindUnpaidMemberAction(input: {
  periodId: string;
  memberId: string;
  // Set once the admin has confirmed sending despite the member-email pause.
  overridePause?: boolean;
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
  if (period.fund.confirmationEmailsPausedAt && !input.overridePause) {
    return { pausedConfirmRequired: true };
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
  | PausedConfirmRequired
  | { error: string };

export async function remindPeriodUnpaidAction(input: {
  periodId: string;
  // Set once the admin has confirmed sending despite the member-email pause.
  overridePause?: boolean;
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
  if (period.fund.confirmationEmailsPausedAt && !input.overridePause) {
    return { pausedConfirmRequired: true };
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
  // Public "how to pay this contribution" page, keyed on the card UID.
  const paymentLink = member.primaryCard
    ? buildPaymentPageUrl(fund.domain, member.primaryCard.serialNumber)
    : "";

  await sendPaymentReminder({
    emailId,
    fundId: fund.id,
    // The manual follow-up nudge resolves the SECOND reminder's own template.
    type: "PAYMENT_REMINDER_SECOND",
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
    // The bank-transfer reference is the card UID — the only value bank-sync
    // matches an incoming deposit on (see services/bank-sync/matching/match.ts).
    paymentReference: member.primaryCard?.serialNumber ?? "",
    cardLink,
    paymentLink,
  });

  const after = await prisma.email.findUnique({
    where: { id: emailId },
    select: { status: true },
  });
  return after?.status === "SENT" ? "sent" : "failed";
}
