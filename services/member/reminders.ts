// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import type { FundBranding } from "@/services/email/transactional";
import { prisma } from "@/services/db/prisma";
import { sendPaymentReminder } from "@/services/email/transactional";
import { buildCardLink } from "@/services/email/templates";
import { buildPaymentPageUrl } from "@/services/payment/pay-link";
import { resolveRequestedContribution } from "./contribution";
import { REMINDER_ELIGIBLE_STATUS } from "./eligibility";

// Monthly payment-request reminder (issue #39). Driven by the
// /api/cron/payment-reminders cron on the 1st of each month. For every
// FIXED_PERIOD fund with a current open allocation period, emails the members
// who are expected to contribute but haven't yet for this period.
//
// Exclusions (per the issue) are applied as query filters so we never even
// queue an Email row for an excluded member:
//   - status not ACTIVE (covers paused / stopped / new / inactive / rejected)
//   - no card assigned yet
//   - not in a tier (no defined contribution amount to request)
//   - opted out of reminders (Member.emailUnsubscribed — set at registration
//     or via the deregistration link, issue #40)
//   - already has an INCOMING contribution attributed to this period (handles
//     "paid at the end of last month for this one", since bank-sync attributes
//     each deposit to the right period window)
//
// PAY_AND_GO funds top up on demand and have no monthly request concept — they
// are skipped entirely.

const FUND_SELECT = {
  id: true,
  name: true,
  primaryColor: true,
  logoUrl: true,
  senderEmail: true,
  // Canonical host — used to build the public /pay/<serial> {paymentLink}.
  domain: true,
  // Cached treasury slug for the public card/account link in the email body.
  citizenPayTreasurySlug: true,
} as const;

export type FundReminderStats = {
  fundId: string;
  fundName: string;
  periodId: string;
  periodLabel: string;
  eligible: number;
  sent: number;
  alreadySent: number;
  failed: number;
};

export async function sendMonthlyPaymentReminders(): Promise<
  FundReminderStats[]
> {
  const now = new Date();
  const funds = await prisma.fund.findMany({
    where: { allocationMode: "FIXED_PERIOD" },
    select: FUND_SELECT,
  });

  const results: FundReminderStats[] = [];
  for (const fund of funds) {
    try {
      const stats = await remindFund(fund, now);
      if (stats) results.push(stats);
    } catch (e) {
      // One fund's failure must not abort the rest of the run.
      console.error("[payment-reminders] fund failed", fund.id, e);
    }
  }
  return results;
}

type ReminderFund = {
  id: string;
  name: string;
  primaryColor: string | null;
  logoUrl: string | null;
  senderEmail: string | null;
  domain: string;
  citizenPayTreasurySlug: string | null;
};

async function remindFund(
  fund: ReminderFund,
  now: Date,
): Promise<FundReminderStats | null> {
  // The current open period: the most recently started OPEN period whose
  // window has begun. If close hasn't run yet there could be more than one
  // OPEN row; the latest-started one is "this month".
  const period = await prisma.allocationPeriod.findFirst({
    where: { fundId: fund.id, status: "OPEN", startsAt: { lte: now } },
    orderBy: { startsAt: "desc" },
    select: { id: true, label: true },
  });
  if (!period) return null;

  const members = await prisma.member.findMany({
    where: {
      fundId: fund.id,
      status: REMINDER_ELIGIBLE_STATUS,
      emailUnsubscribed: false,
      cards: { some: {} },
      // A member can only be reminded to pay a contribution if they're in a
      // tier — the tier defines the expected amount ({amount}). Tier-less
      // members have no contribution to request, so they're excluded.
      tierId: { not: null },
      bankTransactions: {
        none: { direction: "INCOMING", allocationPeriodId: period.id },
      },
    },
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      contributionAmount: true,
      tier: { select: { allocationAmount: true } },
      primaryCard: { select: { serialNumber: true } },
    },
  });

  const branding: FundBranding = {
    name: fund.name,
    primaryColor: fund.primaryColor,
    logoUrl: fund.logoUrl,
    senderEmail: fund.senderEmail,
  };

  let sent = 0;
  let alreadySent = 0;
  let failed = 0;
  for (const member of members) {
    const status = await remindOne(fund, period, member, branding);
    if (status === "sent") sent++;
    else if (status === "alreadySent") alreadySent++;
    else failed++;
  }

  return {
    fundId: fund.id,
    fundName: fund.name,
    periodId: period.id,
    periodLabel: period.label,
    eligible: members.length,
    sent,
    alreadySent,
    failed,
  };
}

type ReminderMember = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  contributionAmount: { toString(): string } | null;
  tier: { allocationAmount: { toString(): string } } | null;
  primaryCard: { serialNumber: string } | null;
};

type SendStatus = "sent" | "alreadySent" | "failed";

// Queue + send one reminder, idempotent per (period, member) so re-running the
// cron (or running it twice in a month) never double-sends. Mirrors the
// allocation-confirmation notify pattern: P2002 on the idempotency key means a
// row already exists — SENT → skip, otherwise reuse the row and retry.
async function remindOne(
  fund: ReminderFund,
  period: { id: string; label: string },
  member: ReminderMember,
  branding: FundBranding,
): Promise<SendStatus> {
  if (!member.email) return "failed";
  const idempotencyKey = `PAYMENT_REMINDER_FIRST:period:${period.id}:member:${member.id}`;

  let emailId: string;
  try {
    const row = await prisma.email.create({
      data: {
        fundId: fund.id,
        type: "PAYMENT_REMINDER_FIRST",
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
      console.error("[payment-reminders] queue failed", member.id, e);
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

  // Use the cached treasury slug directly (no live CP fetch in the batch path).
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
    toEmail: member.email,
    fund: branding,
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
