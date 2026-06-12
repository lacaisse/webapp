// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { Prisma } from "@/services/db/generated/client";

import { getCitizenPayClient } from "@/services/citizenpay/client";
import { prisma } from "@/services/db/prisma";
import { ALLOCATION_ELIGIBLE_STATUS } from "@/services/member/eligibility";
import { resolveOrEnqueueAnnotation } from "@/services/transaction-annotation/pending";

// Shared allocation-run engine for FIXED_PERIOD funds. Both the cutoff cron
// (close.ts) and the manual run actions (run-actions.ts) plan and execute
// mints through this module, so the eligibility rules live in exactly one
// place and a member can never be allocated twice for the same period: a
// member with an existing non-FAILED MINT in the period is simply not a
// candidate anymore. That makes runs idempotent — an admin can allocate
// early (single member or bulk) and the close cron will only pick up
// whoever is still waiting; a late deposit attributed to a CLOSED period
// can be allocated afterwards the same way.

export type AllocationRunFund = {
  id: string;
  citizenPayFundId: string | null;
  citizenPayApiKeyId: string | null;
  citizenPayApiKeyEnc: string | null;
  // For resolving the mint's userOp hash to its settlement tx (annotation).
  tokenChainId: number;
};

export type AllocationPlan = {
  memberId: string;
  memberName: string;
  tierId: string;
  tierName: string;
  account: string;
  // Tokens to mint — the tier's allocationAmount, independent of the deposit.
  amount: Prisma.Decimal;
  // Sum of the member's matched INCOMING deposits in the period.
  deposited: Prisma.Decimal;
  bankTransactionIds: string[];
};

export type AllocationPlanPage = {
  plans: AllocationPlan[];
  // Depositors examined but not planned (total below their tier minimum, or
  // a tier/card that vanished between query and plan). Admin reviews these.
  skipped: number;
  // Cursor for the next page (last member id examined), or null when this
  // page exhausted the candidates. Cursor paging is by member id so a chunked
  // run always advances even past members whose submission failed.
  nextCursor: string | null;
};

// Candidates: ACTIVE members with a tier and a primary card, at least one
// matched INCOMING deposit in the period, and no non-FAILED MINT for the
// period yet (a FAILED op got a CP verdict — the member may be retried, and
// the new op re-links the same source deposits).
export async function findAllocationPlans(args: {
  fundId: string;
  periodId: string;
  memberId?: string;
  afterMemberId?: string;
  take?: number;
}): Promise<AllocationPlanPage> {
  const members = await prisma.member.findMany({
    where: {
      fundId: args.fundId,
      status: ALLOCATION_ELIGIBLE_STATUS,
      tierId: { not: null },
      primaryCardId: { not: null },
      bankTransactions: {
        some: { allocationPeriodId: args.periodId, direction: "INCOMING" },
      },
      tokenOperations: {
        none: {
          allocationPeriodId: args.periodId,
          type: "MINT",
          status: { not: "FAILED" },
        },
      },
      ...(args.memberId
        ? { id: args.memberId }
        : args.afterMemberId
          ? { id: { gt: args.afterMemberId } }
          : {}),
    },
    orderBy: { id: "asc" },
    ...(args.take ? { take: args.take } : {}),
    select: {
      id: true,
      firstName: true,
      lastName: true,
      tierId: true,
      tier: {
        select: {
          name: true,
          minContribution: true,
          allocationAmount: true,
        },
      },
      primaryCard: { select: { account: true } },
      bankTransactions: {
        where: { allocationPeriodId: args.periodId, direction: "INCOMING" },
        select: { id: true, amount: true },
      },
    },
  });

  const plans: AllocationPlan[] = [];
  let skipped = 0;
  for (const m of members) {
    if (!m.tier || !m.tierId || !m.primaryCard?.account) {
      skipped++;
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
      memberName: `${m.firstName} ${m.lastName}`.trim(),
      tierId: m.tierId,
      tierName: m.tier.name,
      account: m.primaryCard.account,
      amount: m.tier.allocationAmount,
      deposited: total,
      bankTransactionIds: m.bankTransactions.map((b) => b.id),
    });
  }

  const exhausted = !args.take || members.length < args.take;
  return {
    plans,
    skipped,
    nextCursor: exhausted ? null : members[members.length - 1].id,
  };
}

export type ExecutedAllocation = {
  // False when the member already had a non-FAILED mint for the period
  // (raced by a concurrent run / the close cron) — nothing was written.
  created: boolean;
  // True once CP accepted the mint. What happens to a created-but-not-
  // submitted op depends on `settlement` (see below).
  submitted: boolean;
  opId: string | null;
};

// Op + source links in one transaction (with a re-check so a concurrent run
// can't double-mint); CP submission outside (HTTP latency shouldn't hold a
// DB lock). Mirrors the PAY_AND_GO path in services/bank-sync/allocate.ts.
export async function executeAllocationMint(args: {
  fund: AllocationRunFund;
  periodId: string;
  plan: AllocationPlan;
  // Annotation audit fields. `trigger` is also used as the annotation kind.
  trigger: string;
  triggeredByUserId?: string | null;
  // Annotation note — pass the period label so the on-chain history shows
  // WHICH allocation produced the mint, not just that one did.
  note?: string | null;
  // What happens to the op after the CP submission:
  //  - "cron": leave it PENDING. The operation-status cron confirms it and
  //    sends the member the allocation-confirmation email; a failed submit
  //    is resubmitted by the mint-retry cron. (Period-close behavior.)
  //  - "direct": settle in-line — CONFIRMED on submit (CP REST mints are
  //    synchronous; the status cron would only rubber-stamp it a tick later),
  //    FAILED on error. The status cron never sees the op, so NO confirmation
  //    email goes out (manual runs don't email members yet), and a FAILED op
  //    puts the member back in the "ready to allocate" list for another try.
  settlement: "cron" | "direct";
  // How long to wait for the userOp to settle so the annotation lands on the
  // real tx hash immediately (instead of via the annotation-resolve cron).
  // Use a few seconds when an admin is watching; omit for batch/cron paths.
  annotationWaitMs?: number;
}): Promise<ExecutedAllocation> {
  const { fund, plan } = args;

  const op = await prisma.$transaction(async (tx) => {
    const existing = await tx.tokenOperation.findFirst({
      where: {
        memberId: plan.memberId,
        allocationPeriodId: args.periodId,
        type: "MINT",
        status: { not: "FAILED" },
      },
      select: { id: true },
    });
    if (existing) return null;

    const created = await tx.tokenOperation.create({
      data: {
        fundId: fund.id,
        type: "MINT",
        memberId: plan.memberId,
        tierId: plan.tierId,
        allocationPeriodId: args.periodId,
        account: plan.account,
        amount: plan.amount,
        status: "PENDING",
      },
    });
    if (plan.bankTransactionIds.length > 0) {
      await tx.tokenOperationSource.createMany({
        data: plan.bankTransactionIds.map((bid) => ({
          bankTransactionId: bid,
          tokenOperationId: created.id,
        })),
      });
    }
    return created;
  });

  if (!op) return { created: false, submitted: false, opId: null };

  try {
    const cp = getCitizenPayClient(fund);
    const result = await cp.submitMint({
      fundCitizenPayId: fund.citizenPayFundId,
      toAccount: plan.account,
      amount: plan.amount.toString(),
      reference: op.id,
    });
    await prisma.tokenOperation.update({
      where: { id: op.id },
      data:
        args.settlement === "direct"
          ? {
              txHash: result.txHash,
              status: "CONFIRMED",
              confirmedAt: new Date(),
            }
          : { txHash: result.txHash },
    });
    // CP's top-up endpoint submits a UserOp and returns the userOp hash, NOT
    // the on-chain settlement tx hash the transfer history is keyed by — so
    // annotating it directly would be invisible. Resolve via the bundler (or
    // queue a pending annotation for the annotation-resolve cron).
    await resolveOrEnqueueAnnotation({
      fundId: fund.id,
      chainId: fund.tokenChainId,
      userOpHash: result.txHash,
      kind: args.trigger,
      note: args.note ?? null,
      trigger: args.trigger,
      triggeredByUserId: args.triggeredByUserId ?? null,
      waitMs: args.annotationWaitMs,
    });
    return { created: true, submitted: true, opId: op.id };
  } catch (e) {
    console.error("[allocation-run] submitMint failed", op.id, e);
    if (args.settlement === "direct") {
      // Surface the failure: FAILED ops don't block the member from a fresh
      // attempt (the candidate filter ignores them) and don't get picked up
      // by the mint-retry cron (which only resubmits PENDING ops).
      await prisma.tokenOperation.update({
        where: { id: op.id },
        data: { status: "FAILED", errorMessage: String(e) },
      });
    }
    // "cron": op stays PENDING with no txHash — the mint-retry cron resubmits.
    return { created: true, submitted: false, opId: op.id };
  }
}
