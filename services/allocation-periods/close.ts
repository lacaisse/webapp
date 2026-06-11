// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { Prisma } from "@/services/db/generated/client";

import { getCitizenPayClient } from "@/services/citizenpay/client";
import { prisma } from "@/services/db/prisma";
import {
  annotateTransaction,
  ANNOTATION_TRIGGERS,
} from "@/services/transaction-annotation/annotate";

import { ensureOpenPeriod } from "./ensure";

// Period close: FIXED_PERIOD funds accumulate deposits within an
// AllocationPeriod, then mint tokens for each contributing member at the
// period's cutoff. This module finds OPEN periods that have passed cutoff,
// runs the batch mint, marks the period CLOSED, and opens the next calendar
// month's period (via ensureOpenPeriod, using the fund's cutoff day).
//
// Minting amount per member = their tier's `allocationAmount` IF the sum
// of their matched deposits within the period reaches the tier's
// minContribution. Totals above maxContribution still mint (generosity is
// welcome); only below-minimum totals get no auto-mint — admin reviews.

export type ClosePeriodStats = {
  fundId: string;
  periodId: string;
  label: string;
  mintsCreated: number;
  mintsSubmitted: number;
  skipped: number;
  nextPeriodId: string | null;
};

export async function closeExpiredPeriods(): Promise<ClosePeriodStats[]> {
  const now = new Date();
  const candidates = await prisma.allocationPeriod.findMany({
    // Only FIXED_PERIOD funds batch-mint. If a fund switched to PAY_AND_GO or
    // DISABLED, any leftover OPEN period must NOT mint at cutoff.
    where: {
      status: "OPEN",
      cutoffDate: { lte: now },
      fund: { allocationMode: "FIXED_PERIOD" },
    },
    orderBy: { cutoffDate: "asc" },
    select: {
      id: true,
      fundId: true,
      label: true,
      startsAt: true,
      cutoffDate: true,
      fund: {
        select: {
          id: true,
          citizenPayFundId: true,
          citizenPayApiKeyId: true,
          citizenPayApiKeyEnc: true,
          allocationCutoffDay: true,
        },
      },
    },
  });

  const results: ClosePeriodStats[] = [];
  for (const period of candidates) {
    try {
      const stats = await closePeriod(period);
      results.push(stats);
    } catch (e) {
      console.error("[period-close] failed", period.id, e);
    }
  }
  return results;
}

type PeriodToClose = {
  id: string;
  fundId: string;
  label: string;
  startsAt: Date;
  cutoffDate: Date;
  fund: {
    id: string;
    citizenPayFundId: string | null;
    citizenPayApiKeyId: string | null;
    citizenPayApiKeyEnc: string | null;
    allocationCutoffDay: number;
  };
};

async function closePeriod(period: PeriodToClose): Promise<ClosePeriodStats> {
  // Find every ACTIVE member of the fund with a tier + a primary card,
  // and pull their matched INCOMING bank transactions in this period.
  const members = await prisma.member.findMany({
    where: {
      fundId: period.fundId,
      status: "ACTIVE",
      tierId: { not: null },
      primaryCardId: { not: null },
    },
    select: {
      id: true,
      tierId: true,
      tier: {
        select: {
          minContribution: true,
          allocationAmount: true,
        },
      },
      primaryCard: { select: { account: true } },
      bankTransactions: {
        where: { allocationPeriodId: period.id, direction: "INCOMING" },
        select: { id: true, amount: true },
      },
    },
  });

  type Plan = {
    memberId: string;
    tierId: string;
    account: string;
    amount: Prisma.Decimal;
    bankTransactionIds: string[];
  };
  const plans: Plan[] = [];
  let skipped = 0;
  for (const m of members) {
    if (!m.tier || !m.tierId || !m.primaryCard?.account) {
      skipped++;
      continue;
    }
    if (m.bankTransactions.length === 0) {
      // No deposit at all — nothing to mint. Not "skipped" in the sense of
      // a problem; the member just didn't contribute this period.
      continue;
    }
    const total = m.bankTransactions.reduce<Prisma.Decimal>(
      (sum, tx) => sum.add(tx.amount),
      new Prisma.Decimal(0),
    );
    // Only below-minimum totals are excluded. Paying MORE than the tier
    // maximum is a good thing — it still earns the allocation.
    if (total.lt(m.tier.minContribution)) {
      skipped++;
      continue; // below minimum — admin handles manually
    }
    plans.push({
      memberId: m.id,
      tierId: m.tierId,
      account: m.primaryCard.account,
      amount: m.tier.allocationAmount,
      bankTransactionIds: m.bankTransactions.map((b) => b.id),
    });
  }

  // Single transaction: flip period to CLOSED, create all ops + source links.
  // We close the period BEFORE submitting to CP so the period is locked even
  // if HTTP calls fail. PENDING ops without txHash can be retried by a
  // separate submit job (TBD).
  const created = await prisma.$transaction(async (tx) => {
    await tx.allocationPeriod.update({
      where: { id: period.id },
      data: { status: "CLOSED", closedAt: new Date() },
    });
    const ops: Array<Plan & { opId: string }> = [];
    for (const plan of plans) {
      const op = await tx.tokenOperation.create({
        data: {
          fundId: period.fundId,
          type: "MINT",
          memberId: plan.memberId,
          tierId: plan.tierId,
          allocationPeriodId: period.id,
          account: plan.account,
          amount: plan.amount,
          status: "PENDING",
        },
      });
      if (plan.bankTransactionIds.length > 0) {
        await tx.tokenOperationSource.createMany({
          data: plan.bankTransactionIds.map((bid) => ({
            bankTransactionId: bid,
            tokenOperationId: op.id,
          })),
        });
      }
      ops.push({ ...plan, opId: op.id });
    }
    return ops;
  });

  // Outside the transaction: submit each mint to CP. Failures leave the op
  // PENDING with no txHash; the period stays CLOSED regardless.
  const cp = getCitizenPayClient(period.fund);
  let submitted = 0;
  for (const op of created) {
    try {
      const result = await cp.submitMint({
        fundCitizenPayId: period.fund.citizenPayFundId,
        toAccount: op.account,
        amount: op.amount.toString(),
        reference: op.opId,
      });
      await prisma.tokenOperation.update({
        where: { id: op.opId },
        data: { txHash: result.txHash },
      });
      // System-triggered batch mint (cron) — no acting admin.
      await annotateTransaction({
        fundId: period.fundId,
        txHash: result.txHash,
        kind: ANNOTATION_TRIGGERS.periodClose,
        trigger: ANNOTATION_TRIGGERS.periodClose,
        triggeredByUserId: null,
      });
      submitted++;
    } catch (e) {
      console.error("[period-close] submitMint failed", op.opId, e);
    }
  }

  // Auto-create the next OPEN period. Once a period is closed, "now" is past
  // its cutoff, so ensureOpenPeriod resolves to the next calendar month.
  const nextPeriodId = await ensureOpenPeriod(
    period.fundId,
    period.fund.allocationCutoffDay,
  );

  return {
    fundId: period.fundId,
    periodId: period.id,
    label: period.label,
    mintsCreated: created.length,
    mintsSubmitted: submitted,
    skipped,
    nextPeriodId,
  };
}

