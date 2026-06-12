// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";

import { requireFundRole } from "@/services/auth/dal";
import { prisma } from "@/services/db/prisma";
import { ANNOTATION_TRIGGERS } from "@/services/transaction-annotation/annotate";
import { processPendingAnnotations } from "@/services/transaction-annotation/pending";

import { executeAllocationMint, findAllocationPlans } from "./run";

// Manual allocation runs for FIXED_PERIOD periods, driven from the period
// detail page. Two shapes:
//   - single: mint one member's allocation now (e.g. a late payment that was
//     attributed to an already-CLOSED period);
//   - bulk: chunked — the client loops, one small batch of members per server
//     action call, so a big run shows progress and can be stopped/resumed
//     (same pattern as the manual full bank-sync).
// Both work on OPEN and CLOSED periods: eligibility (deposits ≥ tier minimum,
// not already allocated) lives in ./run.ts, shared with the close cron, so
// running early never double-mints at cutoff.
//
// Manual runs settle their ops directly ("direct" settlement): CONFIRMED on
// submit, FAILED on error. That keeps them out of the operation-status cron,
// which is what sends members the allocation-confirmation email — manual runs
// don't email members yet. Each mint's tx is annotated ALLOCATION_RUN with
// the period label as the note.

// Members per bulk chunk. Each member costs one CP HTTP round-trip; keep the
// chunk small enough that a server-action call stays well under timeout.
const CHUNK_SIZE = 5;

type FundRoleContext = Awaited<ReturnType<typeof requireFundRole>>;

type PeriodContext =
  | { error: string }
  | {
      error?: undefined;
      user: FundRoleContext["user"];
      fund: FundRoleContext["fund"];
      period: { id: string; label: string };
    };

async function requirePeriod(periodId: string): Promise<PeriodContext> {
  const t = await getTranslations();
  const { user, fund } = await requireFundRole("ADMIN");
  if (fund.allocationMode !== "FIXED_PERIOD") {
    return { error: t("periods.errors.notFixedPeriod" as never) };
  }
  const period = await prisma.allocationPeriod.findFirst({
    where: { id: periodId, fundId: fund.id },
    select: { id: true, label: true },
  });
  if (!period) {
    return { error: t("periods.errors.notFound" as never) };
  }
  return { user, fund, period };
}

export type AllocateMemberResult =
  | { ok: true; submitted: boolean }
  | { error: string };

export async function allocatePeriodMemberAction(input: {
  periodId: string;
  memberId: string;
}): Promise<AllocateMemberResult> {
  const t = await getTranslations();
  const ctx = await requirePeriod(input.periodId);
  if (ctx.error !== undefined) return { error: ctx.error };
  const { user, fund, period } = ctx;

  const { plans } = await findAllocationPlans({
    fundId: fund.id,
    periodId: period.id,
    memberId: input.memberId,
  });
  // Not a candidate: no qualifying deposit total, missing tier/card, not
  // ACTIVE — or already allocated for this period.
  if (plans.length === 0) {
    return {
      error: t("fund.allocations.periodDetail.run.errors.notEligible" as never),
    };
  }

  const result = await executeAllocationMint({
    fund,
    periodId: period.id,
    plan: plans[0],
    trigger: ANNOTATION_TRIGGERS.allocationRun,
    triggeredByUserId: user.id,
    note: period.label,
    settlement: "direct",
    // The admin is watching a single mint: wait for the userOp to settle so
    // the annotation + trigger are on the transaction right away.
    annotationWaitMs: 5_000,
  });
  if (!result.created) {
    return {
      error: t(
        "fund.allocations.periodDetail.run.errors.alreadyAllocated" as never,
      ),
    };
  }
  revalidatePath(`/allocations/periods/${period.id}`);
  revalidatePath("/allocations");
  // Direct settlement: not-submitted means the op was marked FAILED — tell
  // the admin instead of silently closing the dialog. The member stays in
  // the ready list for another attempt.
  if (!result.submitted) {
    return {
      error: t(
        "fund.allocations.periodDetail.run.errors.submitFailed" as never,
      ),
    };
  }
  return { ok: true, submitted: result.submitted };
}

export type RunAllocationChunkResult =
  | {
      ok: true;
      stats: {
        minted: number;
        submitted: number;
        failed: number;
        skipped: number;
      };
      nextCursor: string | null;
      done: boolean;
    }
  | { error: string };

export async function runPeriodAllocationChunkAction(input: {
  periodId: string;
  cursor?: string;
}): Promise<RunAllocationChunkResult> {
  const ctx = await requirePeriod(input.periodId);
  if (ctx.error !== undefined) return { error: ctx.error };
  const { user, fund, period } = ctx;

  const { plans, skipped, nextCursor } = await findAllocationPlans({
    fundId: fund.id,
    periodId: period.id,
    afterMemberId: input.cursor,
    take: CHUNK_SIZE,
  });

  let minted = 0;
  let submitted = 0;
  let failed = 0;
  for (const plan of plans) {
    const result = await executeAllocationMint({
      fund,
      periodId: period.id,
      plan,
      trigger: ANNOTATION_TRIGGERS.allocationRun,
      triggeredByUserId: user.id,
      note: period.label,
      settlement: "direct",
    });
    if (result.created) minted++;
    if (result.submitted) submitted++;
    else if (result.created) failed++;
  }

  const done = nextCursor === null;
  // Per-mint annotation is a single fast bundler poll (no settle-wait, to
  // keep the chunk quick); userOps typically settle in seconds, so draining
  // the pending-annotation queue here resolves the previous chunk's mints —
  // and, on the final chunk after a short grace, this run's last mints —
  // without waiting for the annotation-resolve cron.
  if (done && (minted > 0 || input.cursor)) {
    await new Promise((r) => setTimeout(r, 2_000));
  }
  if (minted > 0 || done) {
    await processPendingAnnotations();
  }
  if (done) {
    revalidatePath(`/allocations/periods/${period.id}`);
    revalidatePath("/allocations");
  }
  return {
    ok: true,
    stats: { minted, submitted, failed, skipped },
    nextCursor,
    done,
  };
}
