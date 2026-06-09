// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { prisma } from "@/services/db/prisma";

import { activePeriodFor } from "./calendar";

// Auto-create the allocation period a FIXED_PERIOD fund needs right now.
//
// "The period to attach a deposit arriving now to" — see activePeriodFor for
// the cutoff-roll-over rule. Idempotent on (fundId, label): if the period
// already exists we return it; otherwise we create it OPEN. This is what fixes
// the bootstrap gap — the first period (and any month nobody deposited in) is
// created on demand rather than only as a side effect of closing the previous
// one.
//
// Called from bank-sync ingest (so no FIXED_PERIOD deposit is ever orphaned
// with a null period) and from the period-close cron (so even empty funds keep
// a current open period).
export async function ensureOpenPeriod(
  fundId: string,
  cutoffDay: number,
  now: Date = new Date(),
): Promise<string> {
  const w = activePeriodFor(now, cutoffDay);

  const existing = await prisma.allocationPeriod.findUnique({
    where: { fundId_label: { fundId, label: w.label } },
    select: { id: true, status: true },
  });
  if (existing) {
    if (existing.status === "CLOSED") {
      // The active-period label maps to an already-closed period. Only reachable
      // via a manual/early close (activePeriodFor never returns a past-cutoff
      // month), so don't silently attach new deposits to it — surface it.
      console.warn(
        "[ensure-period] active period label is CLOSED; deposits will attach to a closed period",
        fundId,
        w.label,
      );
    }
    return existing.id;
  }

  try {
    const created = await prisma.allocationPeriod.create({
      data: {
        fundId,
        label: w.label,
        startsAt: w.startsAt,
        cutoffDate: w.cutoffDate,
        status: "OPEN",
      },
      select: { id: true },
    });
    return created.id;
  } catch (e) {
    // P2002 on (fundId, label): a concurrent ingest/cron created it first. Re-read.
    if ((e as { code?: string }).code === "P2002") {
      const row = await prisma.allocationPeriod.findUnique({
        where: { fundId_label: { fundId, label: w.label } },
        select: { id: true },
      });
      if (row) return row.id;
    }
    throw e;
  }
}

// Bootstrap: make sure every connected FIXED_PERIOD fund has a current open
// period, even if it has had no deposits yet (ingest only runs ensureOpenPeriod
// when a deposit lands). Run from the period-close cron so the very first
// period appears without waiting for the first contribution. Returns the count
// of funds processed.
export async function ensureOpenPeriodsForFixedFunds(
  now: Date = new Date(),
): Promise<number> {
  const funds = await prisma.fund.findMany({
    where: {
      allocationMode: "FIXED_PERIOD",
      citizenPayFundId: { not: null },
    },
    select: { id: true, allocationCutoffDay: true },
  });
  let processed = 0;
  for (const f of funds) {
    try {
      await ensureOpenPeriod(f.id, f.allocationCutoffDay, now);
      processed++;
    } catch (e) {
      console.error("[ensure-period] bootstrap failed", f.id, e);
    }
  }
  return processed;
}
