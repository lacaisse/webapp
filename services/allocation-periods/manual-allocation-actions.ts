// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";

import { requireFundRole } from "@/services/auth/dal";
import { prisma } from "@/services/db/prisma";

// Reconcile MANUAL allocations after the fact. A "manual allocation" is a MINT
// TokenOperation an admin created by hand (card recharge, member mint, /token)
// that isn't tied to a bank deposit (no TokenOperationSource). These show up in
// the allocations History with source "Manual" and no period.
//
// Two ways to reconcile, both data-only (no on-chain effect — the mint already
// happened):
//   - setTokenOperationPeriodAction: tag a manual allocation to a period (from
//     the History tab).
//   - attachAllocationToDepositAction: link a manual allocation to a specific
//     incoming deposit on a period (from the period's Deposits tab), which also
//     pulls it into that deposit's period and flips the deposit to "allocated".

export type ManualAllocationResult = { ok: true } | { error: string };

// Assign (or clear) the allocation period of a manual MINT. Refused for ops
// already linked to a deposit — those take their period from the deposit, so
// reassigning here would desync. Period-less / DISABLED funds have no periods,
// so the picker simply isn't offered there.
export async function setTokenOperationPeriodAction(input: {
  tokenOperationId: string;
  periodId: string | null;
}): Promise<ManualAllocationResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const op = await prisma.tokenOperation.findFirst({
    where: { id: input.tokenOperationId, fundId: fund.id, type: "MINT" },
    select: {
      id: true,
      allocationPeriodId: true,
      _count: { select: { sources: true } },
    },
  });
  if (!op) {
    return { error: t("fund.allocations.reconcile.errors.opNotFound" as never) };
  }
  if (op._count.sources > 0) {
    return { error: t("fund.allocations.reconcile.errors.notManual" as never) };
  }

  if (input.periodId) {
    const period = await prisma.allocationPeriod.findFirst({
      where: { id: input.periodId, fundId: fund.id },
      select: { id: true },
    });
    if (!period) {
      return {
        error: t("fund.allocations.reconcile.errors.periodNotFound" as never),
      };
    }
  }

  await prisma.tokenOperation.update({
    where: { id: op.id },
    data: { allocationPeriodId: input.periodId },
  });

  revalidatePath("/allocations");
  if (op.allocationPeriodId) {
    revalidatePath(`/allocations/periods/${op.allocationPeriodId}`);
  }
  if (input.periodId && input.periodId !== op.allocationPeriodId) {
    revalidatePath(`/allocations/periods/${input.periodId}`);
  }
  return { ok: true };
}

// A manual allocation the admin can attach to a deposit — the member's
// unmatched manual MINTs, newest first. `periodLabel` is the op's current
// period (if any), shown so the admin can spot one already in another period.
export type PickableManualAllocation = {
  id: string;
  amount: string;
  submittedAt: string; // ISO 8601
  status: "PENDING" | "CONFIRMED" | "FAILED";
  tierName: string | null;
  periodLabel: string | null;
};

export type ListManualAllocationsResult =
  | { error: string }
  | { ok: true; allocations: PickableManualAllocation[] };

// Manual allocations for the member a deposit is matched to — the candidates
// for the deposit's "attach allocation" picker. Scoped to the deposit's member
// (the whole point is finding the allocation made *for that member*), excludes
// ops already linked to a deposit, and skips FAILED ops (not a real
// allocation). Newest first; a member rarely has many loose manual mints.
const MANUAL_ALLOCATION_LIMIT = 25;

export async function listManualAllocationsAction(input: {
  bankTransactionId: string;
}): Promise<ListManualAllocationsResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const deposit = await prisma.bankTransaction.findFirst({
    where: { id: input.bankTransactionId, fundId: fund.id },
    select: { id: true, memberId: true },
  });
  if (!deposit) {
    return {
      error: t("fund.allocations.reconcile.errors.depositNotFound" as never),
    };
  }
  // No member ⇒ nothing to match against. The UI only offers attach for
  // matched deposits, but guard anyway.
  if (!deposit.memberId) return { ok: true, allocations: [] };

  const ops = await prisma.tokenOperation.findMany({
    where: {
      fundId: fund.id,
      type: "MINT",
      memberId: deposit.memberId,
      status: { in: ["PENDING", "CONFIRMED"] },
      sources: { none: {} },
    },
    orderBy: { submittedAt: "desc" },
    take: MANUAL_ALLOCATION_LIMIT,
    select: {
      id: true,
      amount: true,
      submittedAt: true,
      status: true,
      tier: { select: { name: true } },
      allocationPeriod: { select: { label: true } },
    },
  });

  return {
    ok: true,
    allocations: ops.map((op) => ({
      id: op.id,
      amount: op.amount.toString(),
      submittedAt: op.submittedAt.toISOString(),
      status: op.status,
      tierName: op.tier?.name ?? null,
      periodLabel: op.allocationPeriod?.label ?? null,
    })),
  };
}

// Link a manual allocation to an incoming deposit: create the source link and
// pull the mint into the deposit's period. The deposit then reads as
// "allocated" (its badge looks at linked mints) and the mint joins the period's
// Mints tab. Refused if the mint is already linked elsewhere, or if it belongs
// to a different member than the deposit (a mis-match the admin should resolve
// first).
export async function attachAllocationToDepositAction(input: {
  bankTransactionId: string;
  tokenOperationId: string;
}): Promise<ManualAllocationResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const deposit = await prisma.bankTransaction.findFirst({
    where: { id: input.bankTransactionId, fundId: fund.id, direction: "INCOMING" },
    select: { id: true, memberId: true, allocationPeriodId: true },
  });
  if (!deposit) {
    return {
      error: t("fund.allocations.reconcile.errors.depositNotFound" as never),
    };
  }

  const op = await prisma.tokenOperation.findFirst({
    where: { id: input.tokenOperationId, fundId: fund.id, type: "MINT" },
    select: {
      id: true,
      memberId: true,
      allocationPeriodId: true,
      _count: { select: { sources: true } },
    },
  });
  if (!op) {
    return { error: t("fund.allocations.reconcile.errors.opNotFound" as never) };
  }
  if (op._count.sources > 0) {
    return {
      error: t("fund.allocations.reconcile.errors.alreadyLinked" as never),
    };
  }
  // Both sides carry a member — refuse a cross-member link rather than silently
  // mis-attribute someone's payment to another member's allocation.
  if (
    deposit.memberId &&
    op.memberId &&
    deposit.memberId !== op.memberId
  ) {
    return {
      error: t("fund.allocations.reconcile.errors.memberMismatch" as never),
    };
  }

  await prisma.$transaction(async (db) => {
    await db.tokenOperationSource.create({
      data: {
        bankTransactionId: deposit.id,
        tokenOperationId: op.id,
      },
    });
    // Pull the mint into the deposit's period so it shows under the period's
    // Mints tab (only when the deposit is in a period).
    if (deposit.allocationPeriodId) {
      await db.tokenOperation.update({
        where: { id: op.id },
        data: { allocationPeriodId: deposit.allocationPeriodId },
      });
    }
  });

  revalidatePath("/allocations");
  revalidatePath("/bank");
  if (deposit.allocationPeriodId) {
    revalidatePath(`/allocations/periods/${deposit.allocationPeriodId}`);
  }
  if (op.allocationPeriodId && op.allocationPeriodId !== deposit.allocationPeriodId) {
    revalidatePath(`/allocations/periods/${op.allocationPeriodId}`);
  }
  return { ok: true };
}
