// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse, type NextRequest } from "next/server";

import { getCitizenPayClient } from "@/services/citizenpay/client";
import { cronGate } from "@/services/cron/guard";
import { prisma } from "@/services/db/prisma";
import {
  sendAllocationConfirmation,
  sendReferralBonusAwarded,
} from "@/services/email/transactional";

// Vercel cron entry — see vercel.json. Polls CitizenPay for the status of
// every TokenOperation we've submitted (txHash set, status still PENDING)
// and flips them to CONFIRMED / FAILED. When a referral-reward mint
// confirms, also queues + sends REFERRAL_BONUS_AWARDED to the sponsor.
//
// Ops with NO txHash (submit failed earlier) are out of scope here — those
// need a re-submit, handled separately. We only deal with statuses CP can
// answer.

const BATCH_SIZE = 50;

export async function GET(request: NextRequest) {
  const gate = cronGate(request);
  if (gate) return gate;

  const ops = await prisma.tokenOperation.findMany({
    where: { status: "PENDING", txHash: { not: null } },
    orderBy: { submittedAt: "asc" },
    take: BATCH_SIZE,
    select: {
      id: true,
      txHash: true,
      fundId: true,
      memberId: true,
      amount: true,
      account: true,
      fund: {
        select: {
          id: true,
          name: true,
          primaryColor: true,
          logoUrl: true,
          citizenPayApiKeyId: true,
          citizenPayApiKeyEnc: true,
          confirmationEmailsPausedAt: true,
        },
      },
      member: { select: { email: true, firstName: true, lastName: true } },
      referral: {
        select: {
          id: true,
          sponsor: { select: { id: true, email: true, firstName: true } },
          fund: {
            select: {
              name: true,
              primaryColor: true,
              logoUrl: true,
              referralBonusAmount: true,
            },
          },
        },
      },
      // Just need to know whether sources exist (bank-sync-sourced mint).
      sources: { select: { id: true }, take: 1 },
    },
  });

  let confirmed = 0;
  let failed = 0;

  for (const op of ops) {
    if (!op.txHash) continue;
    let result;
    try {
      const cp = getCitizenPayClient(op.fund);
      result = await cp.getOperationStatus(op.txHash);
    } catch (e) {
      console.error("[citizenpay-cron] getOperationStatus failed", op.id, e);
      continue; // try again next tick
    }

    if (result.status === "CONFIRMED") {
      await prisma.tokenOperation.update({
        where: { id: op.id },
        data: { status: "CONFIRMED", confirmedAt: new Date() },
      });
      confirmed++;

      // Notification routing:
      //   - Referral reward → REFERRAL_BONUS_AWARDED to the sponsor
      //   - Bank-sync allocation (sources non-empty) → ALLOCATION_CONFIRMATION
      //     to the recipient member
      // A mint can be only one of these in practice; check referral first.
      // Both recipients are members, so both respect the fund-level member-
      // email pause: the op still flips CONFIRMED, only the notification is
      // skipped (never sent retroactively on resume).
      if (
        op.referral &&
        op.referral.sponsor.email &&
        op.referral.fund.referralBonusAmount &&
        !op.fund.confirmationEmailsPausedAt
      ) {
        await queueAndSendReferralBonusEmail({
          fundId: op.fundId,
          referralId: op.referral.id,
          sponsorEmail: op.referral.sponsor.email,
          sponsorFirstName: op.referral.sponsor.firstName,
          fundBranding: {
            name: op.referral.fund.name,
            primaryColor: op.referral.fund.primaryColor,
            logoUrl: op.referral.fund.logoUrl,
          },
          amount: op.referral.fund.referralBonusAmount.toString(),
        });
      } else if (
        op.sources.length > 0 &&
        op.member?.email &&
        op.memberId &&
        !op.fund.confirmationEmailsPausedAt
      ) {
        await queueAndSendAllocationConfirmation({
          fundId: op.fundId,
          tokenOperationId: op.id,
          memberId: op.memberId,
          toEmail: op.member.email,
          firstName: op.member.firstName,
          lastName: op.member.lastName,
          account: op.account,
          fundBranding: {
            name: op.fund.name,
            primaryColor: op.fund.primaryColor,
            logoUrl: op.fund.logoUrl,
          },
          amount: op.amount.toString(),
        });
      }
    } else if (result.status === "FAILED") {
      await prisma.tokenOperation.update({
        where: { id: op.id },
        data: {
          status: "FAILED",
          errorMessage: result.errorMessage ?? "Operation failed on CitizenPay",
        },
      });
      failed++;
    }
    // PENDING → leave alone, try again next tick
  }

  return NextResponse.json({ checked: ops.length, confirmed, failed });
}

async function queueAndSendAllocationConfirmation(args: {
  fundId: string;
  tokenOperationId: string;
  memberId: string;
  toEmail: string;
  firstName: string;
  lastName: string;
  account: string | null;
  fundBranding: { name: string; primaryColor: string | null; logoUrl: string | null };
  amount: string;
}) {
  const idempotencyKey = `ALLOCATION_CONFIRMATION:operation:${args.tokenOperationId}`;
  try {
    const emailRow = await prisma.email.create({
      data: {
        fundId: args.fundId,
        type: "ALLOCATION_CONFIRMATION",
        toEmail: args.toEmail,
        memberId: args.memberId,
        tokenOperationId: args.tokenOperationId,
        idempotencyKey,
        subject: "Allocation",
      },
    });
    await sendAllocationConfirmation({
      emailId: emailRow.id,
      fundId: args.fundId,
      toEmail: args.toEmail,
      firstName: args.firstName,
      lastName: args.lastName,
      account: args.account,
      fund: args.fundBranding,
      amount: args.amount,
    });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code !== "P2002") {
      console.error("[citizenpay-cron] allocation email failed", e);
    }
  }
}

async function queueAndSendReferralBonusEmail(args: {
  fundId: string;
  referralId: string;
  sponsorEmail: string;
  sponsorFirstName: string;
  fundBranding: { name: string; primaryColor: string | null; logoUrl: string | null };
  amount: string;
}) {
  // Idempotency: one bonus-awarded email per referral, regardless of how
  // many times the cron sees the op confirmed.
  const idempotencyKey = `REFERRAL_BONUS_AWARDED:referral:${args.referralId}`;
  try {
    const emailRow = await prisma.email.create({
      data: {
        fundId: args.fundId,
        type: "REFERRAL_BONUS_AWARDED",
        toEmail: args.sponsorEmail,
        referralId: args.referralId,
        idempotencyKey,
        // Subject placeholder — sendReferralBonusAwarded overwrites with
        // the rendered subject on success.
        subject: "Referral bonus",
      },
    });
    await sendReferralBonusAwarded({
      emailId: emailRow.id,
      toEmail: args.sponsorEmail,
      firstName: args.sponsorFirstName,
      fund: args.fundBranding,
      amount: args.amount,
    });
  } catch (e) {
    // P2002 on idempotencyKey = already queued/sent. Anything else, log
    // and move on — the cron will revisit, and we don't want one bad
    // email to halt the batch.
    const code = (e as { code?: string }).code;
    if (code !== "P2002") {
      console.error("[citizenpay-cron] referral email failed", e);
    }
  }
}
