// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { prisma } from "@/services/db/prisma";
import { ANNOTATION_TRIGGERS } from "@/services/transaction-annotation/annotate";

import { ensureOpenPeriod } from "./ensure";
import { executeAllocationMint, findAllocationPlans } from "./run";

// Period close: FIXED_PERIOD funds accumulate deposits within an
// AllocationPeriod, then mint tokens for each contributing member at the
// period's cutoff. This module finds OPEN periods that have passed cutoff,
// runs the batch mint, marks the period CLOSED, and opens the next calendar
// month's period (via ensureOpenPeriod, using the fund's cutoff day).
//
// Planning + minting are shared with the manual run actions (see ./run.ts):
// a member who was already allocated for the period (e.g. by an early manual
// run) is not a candidate anymore, so closing after a manual run only mints
// for whoever is still waiting.
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
          tokenChainId: true,
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
    tokenChainId: number;
    allocationCutoffDay: number;
  };
};

async function closePeriod(period: PeriodToClose): Promise<ClosePeriodStats> {
  // Plan first, then lock the period CLOSED BEFORE submitting to CP, so the
  // period stops accepting deposits even if HTTP calls fail. Each mint is
  // created PENDING and submitted by executeAllocationMint; a failed submit
  // leaves the op PENDING for the mint-retry cron, and if the process dies
  // mid-loop the remaining members stay candidates — visible on the period
  // page as "ready to allocate", one bulk run away.
  const { plans, skipped } = await findAllocationPlans({
    fundId: period.fundId,
    periodId: period.id,
  });

  await prisma.allocationPeriod.update({
    where: { id: period.id },
    data: { status: "CLOSED", closedAt: new Date() },
  });

  let created = 0;
  let submitted = 0;
  for (const plan of plans) {
    const result = await executeAllocationMint({
      fund: period.fund,
      periodId: period.id,
      plan,
      // System-triggered batch mint (cron) — no acting admin. The period
      // label in the note ties the on-chain tx back to this allocation.
      trigger: ANNOTATION_TRIGGERS.periodClose,
      triggeredByUserId: null,
      note: period.label,
      // Cron settlement: the status cron confirms and emails the member.
      settlement: "cron",
    });
    if (result.created) created++;
    if (result.submitted) submitted++;
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
    mintsCreated: created,
    mintsSubmitted: submitted,
    skipped,
    nextPeriodId,
  };
}
