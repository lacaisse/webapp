// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { prisma } from "@/services/db/prisma";

import type {
  AllocationExportDeposit,
  AllocationExportMember,
  AllocationExportMint,
  AllocationExportPeriod,
} from "./export";

export type AllocationExportData = {
  periods: AllocationExportPeriod[];
  members: AllocationExportMember[];
  deposits: AllocationExportDeposit[];
  mints: AllocationExportMint[];
};

/**
 * Load what the allocations export (./export.ts) needs for one fund: its
 * periods oldest first — or only `periodId` — with the matched incoming
 * deposits and confirmed mints attached to them, and the members those
 * belong to. Returns null when `periodId` isn't a period of this fund.
 *
 * Every query is scoped by `fundId`, which the caller takes from the request
 * host (requireFundRole), never from input.
 */
export async function loadAllocationExportData(input: {
  fundId: string;
  periodId: string | null;
}): Promise<AllocationExportData | null> {
  const { fundId, periodId } = input;

  const periods = await prisma.allocationPeriod.findMany({
    where: { fundId, ...(periodId ? { id: periodId } : {}) },
    orderBy: [{ cutoffDate: "asc" }, { createdAt: "asc" }],
    select: { id: true, label: true },
  });
  if (periodId && periods.length === 0) return null;

  const periodIds = periods.map((p) => p.id);
  const [deposits, mints] = await Promise.all([
    prisma.bankTransaction.findMany({
      where: {
        fundId,
        direction: "INCOMING",
        allocationPeriodId: { in: periodIds },
        memberId: { not: null },
      },
      select: { allocationPeriodId: true, memberId: true, amount: true },
    }),
    prisma.tokenOperation.findMany({
      where: {
        fundId,
        type: "MINT",
        status: "CONFIRMED",
        allocationPeriodId: { in: periodIds },
        memberId: { not: null },
      },
      // Oldest first: the first mint's tier is the one a period row shows.
      orderBy: { submittedAt: "asc" },
      select: {
        allocationPeriodId: true,
        memberId: true,
        amount: true,
        tier: { select: { name: true, allocationAmount: true } },
      },
    }),
  ]);

  const memberIds = new Set<string>();
  for (const row of [...deposits, ...mints]) {
    if (row.memberId) memberIds.add(row.memberId);
  }
  const members = await prisma.member.findMany({
    where: { fundId, id: { in: [...memberIds] } },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      tier: { select: { name: true, allocationAmount: true } },
    },
  });

  const tierOf = (
    tier: { name: string; allocationAmount: { toString(): string } } | null,
  ) =>
    tier
      ? { name: tier.name, allocationAmount: tier.allocationAmount.toString() }
      : null;

  return {
    periods,
    members: members.map((m) => ({ ...m, tier: tierOf(m.tier) })),
    deposits: deposits.flatMap((d) =>
      d.allocationPeriodId && d.memberId
        ? [
            {
              periodId: d.allocationPeriodId,
              memberId: d.memberId,
              amount: d.amount.toString(),
            },
          ]
        : [],
    ),
    mints: mints.flatMap((m) =>
      m.allocationPeriodId && m.memberId
        ? [
            {
              periodId: m.allocationPeriodId,
              memberId: m.memberId,
              amount: m.amount.toString(),
              tier: tierOf(m.tier),
            },
          ]
        : [],
    ),
  };
}
