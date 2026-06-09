// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireFundRole } from "@/services/auth/dal";
import { prisma } from "@/services/db/prisma";

// Manual period management for FIXED_PERIOD funds. Auto-creation
// (services/allocation-periods/ensure.ts) handles the common case; these
// actions let an admin create a period ahead of time or override the cutoff
// of an open one. A period is one calendar month: the admin picks the cutoff
// date and we derive startsAt (1st of that month) + label ("YYYY-MM").

const PeriodSchema = z.object({
  // yyyy-mm-dd, as produced by a native date input.
  cutoffDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, { error: "periods.errors.dateInvalid" }),
});

export type PeriodInput = z.infer<typeof PeriodSchema>;
export type PeriodMutationResult = { error: string } | { ok: true };

type PeriodWindow = { startsAt: Date; cutoffDate: Date; label: string };

// Parse yyyy-mm-dd into a calendar-month window with an end-of-day cutoff.
// Returns null if the date is not a real calendar date (e.g. 2026-02-31).
function windowFromCutoff(value: string): PeriodWindow | null {
  const [y, m, d] = value.split("-").map(Number);
  const startsAt = new Date(Date.UTC(y, m - 1, 1, 0, 0, 0, 0));
  const cutoffDate = new Date(Date.UTC(y, m - 1, d, 23, 59, 59, 999));
  // Reject overflow (JS rolls 2026-02-31 into March): the round-trip must match.
  if (
    cutoffDate.getUTCFullYear() !== y ||
    cutoffDate.getUTCMonth() !== m - 1 ||
    cutoffDate.getUTCDate() !== d
  ) {
    return null;
  }
  return {
    startsAt,
    cutoffDate,
    label: `${y}-${m.toString().padStart(2, "0")}`,
  };
}

export async function createPeriodAction(
  input: PeriodInput,
): Promise<PeriodMutationResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const parsed = PeriodSchema.safeParse(input);
  if (!parsed.success) {
    return { error: t(parsed.error.issues[0].message as never) };
  }
  const w = windowFromCutoff(parsed.data.cutoffDate);
  if (!w) return { error: t("periods.errors.dateInvalid" as never) };

  try {
    await prisma.allocationPeriod.create({
      data: {
        fundId: fund.id,
        label: w.label,
        startsAt: w.startsAt,
        cutoffDate: w.cutoffDate,
        status: "OPEN",
      },
    });
  } catch (e) {
    // P2002 on (fundId, label): a period for that month already exists.
    if ((e as { code?: string }).code === "P2002") {
      return { error: t("periods.errors.exists" as never) };
    }
    throw e;
  }

  revalidatePath("/allocations");
  return { ok: true };
}

export async function updatePeriodAction(input: {
  periodId: string;
  cutoffDate: string;
}): Promise<PeriodMutationResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const parsed = PeriodSchema.safeParse({ cutoffDate: input.cutoffDate });
  if (!parsed.success) {
    return { error: t(parsed.error.issues[0].message as never) };
  }
  const w = windowFromCutoff(parsed.data.cutoffDate);
  if (!w) return { error: t("periods.errors.dateInvalid" as never) };

  const existing = await prisma.allocationPeriod.findFirst({
    where: { id: input.periodId, fundId: fund.id },
    select: { id: true, label: true, status: true },
  });
  if (!existing) return { error: t("periods.errors.notFound" as never) };
  // A closed period has already minted — its cutoff is history, don't touch it.
  if (existing.status === "CLOSED") {
    return { error: t("periods.errors.closed" as never) };
  }
  // The cutoff must stay within the period's own month — moving it to another
  // month would change the period's identity (its label).
  if (w.label !== existing.label) {
    return { error: t("periods.errors.monthMismatch" as never) };
  }

  await prisma.allocationPeriod.update({
    where: { id: existing.id },
    data: { cutoffDate: w.cutoffDate },
  });

  revalidatePath("/allocations");
  return { ok: true };
}
