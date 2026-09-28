// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";
import { cache } from "react";

import { formatTokenAmount } from "@/services/alchemy/format";
import { getTotalSupply } from "@/services/alchemy/supply";
import { getCitizenPayClient } from "@/services/citizenpay/client";
import { prisma } from "@/services/db/prisma";

// Loaders for the fund analytics dashboard. Every Prisma query of the page
// lives here; the page components only call these. Each loader is wrapped in
// React's `cache()` with primitive args (so repeat reads in one render share a
// round-trip) and every external read (Alchemy, CitizenPay) degrades to null
// on error so a hiccup renders "—" instead of breaking the board's view.
//
// Month boundaries are computed in UTC (1st of the month, 00:00 UTC). That's
// off by an hour or two against the fund's own timezone at the edges, which is
// fine for an at-a-glance view. Amounts leave this module as plain numbers
// (Prisma Decimal → Number) — display precision, not accounting.

export const RANGE_MONTHS = { "3m": 3, "6m": 6, "12m": 12 } as const;
export type DashboardRange = keyof typeof RANGE_MONTHS;

function toNumber(d: { toString(): string } | null | undefined): number {
  if (d == null) return 0;
  const n = Number(d.toString());
  return Number.isFinite(n) ? n : 0;
}

function monthStartUtc(offsetMonths = 0): Date {
  const now = new Date();
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offsetMonths, 1),
  );
}

// First day of the oldest month in a range of `months` calendar months that
// ends with (and includes) the current month.
function rangeStartUtc(months: number): Date {
  return monthStartUtc(-(months - 1));
}

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

// Oldest → newest month starts covering the range.
function monthBuckets(months: number): Date[] {
  const start = rangeStartUtc(months);
  return Array.from(
    { length: months },
    (_, i) =>
      new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + i, 1)),
  );
}

function bucketSums(
  buckets: Date[],
  rows: { date: Date | null; value: number }[],
): number[] {
  const index = new Map(buckets.map((b, i) => [monthKey(b), i]));
  const out = buckets.map(() => 0);
  for (const r of rows) {
    if (!r.date) continue;
    const i = index.get(monthKey(r.date));
    if (i !== undefined) out[i] += r.value;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Hero KPIs
// ---------------------------------------------------------------------------

export type CirculationData = {
  amount: number | null;
  source: "chain" | "cards" | null;
};

// On-chain totalSupply when the token is configured and the RPC answers;
// otherwise the cached sum of the fund's card balances; otherwise null.
export const getCirculation = cache(
  async (
    fundId: string,
    tokenChainId: number | null,
    tokenAddress: string | null,
    tokenDecimals: number | null,
  ): Promise<CirculationData> => {
    if (tokenAddress && tokenChainId != null) {
      try {
        const raw = await getTotalSupply(tokenChainId, tokenAddress);
        const amount = Number(formatTokenAmount(raw, tokenDecimals));
        if (Number.isFinite(amount)) return { amount, source: "chain" };
      } catch (e) {
        console.warn("[dashboard] getTotalSupply failed", e);
      }
    }
    try {
      const agg = await prisma.card.aggregate({
        where: { fundId },
        _sum: { balance: true },
      });
      if (agg._sum.balance != null) {
        return { amount: toNumber(agg._sum.balance), source: "cards" };
      }
    } catch (e) {
      console.warn("[dashboard] card balance sum failed", e);
    }
    return { amount: null, source: null };
  },
);

export const getMemberKpis = cache(
  async (fundId: string): Promise<{ active: number; newThisMonth: number }> => {
    const monthStart = monthStartUtc();
    const [active, newThisMonth] = await Promise.all([
      prisma.member.count({ where: { fundId, status: "ACTIVE" } }),
      prisma.member.count({
        where: {
          fundId,
          joinedAt: { gte: monthStart },
          status: { not: "REJECTED" },
        },
      }),
    ]);
    return { active, newThisMonth };
  },
);

export const getMerchantKpis = cache(
  async (fundId: string): Promise<{ active: number; connected: number }> => {
    const [active, connected] = await Promise.all([
      prisma.merchant.count({ where: { fundId, status: "ACTIVE" } }),
      prisma.merchant.count({
        where: {
          fundId,
          status: "ACTIVE",
          citizenPayActivatedAt: { not: null },
        },
      }),
    ]);
    return { active, connected };
  },
);

export type MonthMoneyKpis = {
  contributions: number;
  deposits: number;
  unmatched: number;
  allocated: number;
  paidOut: number;
  payoutTransfers: number;
};

// "This month" money figures: contributions in, tokens allocated, payouts out.
export const getMonthMoneyKpis = cache(
  async (fundId: string): Promise<MonthMoneyKpis> => {
    const monthStart = monthStartUtc();
    const [incoming, unmatched, allocated, outgoing] = await Promise.all([
      prisma.bankTransaction.aggregate({
        where: {
          fundId,
          direction: "INCOMING",
          occurredAt: { gte: monthStart },
        },
        _sum: { amount: true },
        _count: { _all: true },
      }),
      prisma.bankTransaction.count({
        where: {
          fundId,
          direction: "INCOMING",
          occurredAt: { gte: monthStart },
          memberId: null,
        },
      }),
      prisma.tokenOperation.aggregate({
        where: {
          fundId,
          type: "MINT",
          status: "CONFIRMED",
          confirmedAt: { gte: monthStart },
        },
        _sum: { amount: true },
      }),
      prisma.bankTransaction.aggregate({
        where: {
          fundId,
          direction: "OUTGOING",
          occurredAt: { gte: monthStart },
        },
        _sum: { amount: true },
        _count: { _all: true },
      }),
    ]);
    return {
      contributions: toNumber(incoming._sum.amount),
      deposits: incoming._count._all,
      unmatched,
      allocated: toNumber(allocated._sum.amount),
      paidOut: toNumber(outgoing._sum.amount),
      payoutTransfers: outgoing._count._all,
    };
  },
);

// Pending mints right now, plus mints that failed within the selected range
// (failed rows are kept forever — retries create new rows — so an all-time
// count would never go back to zero).
export const getAllocationHealth = cache(
  async (
    fundId: string,
    months: number,
  ): Promise<{ pending: number; failed: number }> => {
    const [pending, failed] = await Promise.all([
      prisma.tokenOperation.count({
        where: { fundId, type: "MINT", status: "PENDING" },
      }),
      prisma.tokenOperation.count({
        where: {
          fundId,
          type: "MINT",
          status: "FAILED",
          submittedAt: { gte: rangeStartUtc(months) },
        },
      }),
    ]);
    return { pending, failed };
  },
);

// Tokens sitting on merchant (place) accounts, i.e. spent by members and not
// yet paid out. Sum of CitizenPay's per-place balance snapshots, in token
// units. Null when CitizenPay is unreachable or not configured.
export const getMerchantHoldings = cache(
  async (
    fundId: string,
    citizenPayApiKeyId: string | null,
    citizenPayApiKeyEnc: string | null,
  ): Promise<number | null> => {
    try {
      const { places } = await getCitizenPayClient({
        id: fundId,
        citizenPayApiKeyId,
        citizenPayApiKeyEnc,
      }).listPlaces();
      const cents = places.reduce((s, p) => s + (p.balanceCents ?? 0), 0);
      return cents / 100;
    } catch (e) {
      console.warn("[dashboard] listPlaces failed", e);
      return null;
    }
  },
);

// ---------------------------------------------------------------------------
// Time series
// ---------------------------------------------------------------------------

export type MonthlySeries = {
  // Month starts as ISO strings (UTC), oldest first.
  months: string[];
  values: number[][];
};

// Contributions received (INCOMING bank, EUR) and tokens allocated (MINT
// CONFIRMED, by confirmation date) per calendar month over the range.
export const getMoneySeries = cache(
  async (fundId: string, months: number): Promise<MonthlySeries> => {
    const buckets = monthBuckets(months);
    const from = buckets[0];
    const [incoming, mints] = await Promise.all([
      prisma.bankTransaction.findMany({
        where: { fundId, direction: "INCOMING", occurredAt: { gte: from } },
        select: { amount: true, occurredAt: true },
      }),
      prisma.tokenOperation.findMany({
        where: {
          fundId,
          type: "MINT",
          status: "CONFIRMED",
          confirmedAt: { gte: from },
        },
        select: { amount: true, confirmedAt: true },
      }),
    ]);
    return {
      months: buckets.map((b) => b.toISOString()),
      values: [
        bucketSums(
          buckets,
          incoming.map((r) => ({ date: r.occurredAt, value: toNumber(r.amount) })),
        ),
        bucketSums(
          buckets,
          mints.map((r) => ({ date: r.confirmedAt, value: toNumber(r.amount) })),
        ),
      ],
    };
  },
);

// New members per month (by joinedAt), rejected sign-ups excluded, plus the
// running total of members on file at the end of the range.
export const getMemberSeries = cache(
  async (
    fundId: string,
    months: number,
  ): Promise<MonthlySeries & { total: number }> => {
    const buckets = monthBuckets(months);
    const [joined, total] = await Promise.all([
      prisma.member.findMany({
        where: {
          fundId,
          joinedAt: { gte: buckets[0] },
          status: { not: "REJECTED" },
        },
        select: { joinedAt: true },
      }),
      prisma.member.count({
        where: { fundId, status: { not: "REJECTED" } },
      }),
    ]);
    return {
      months: buckets.map((b) => b.toISOString()),
      values: [
        bucketSums(
          buckets,
          joined.map((r) => ({ date: r.joinedAt, value: 1 })),
        ),
      ],
      total,
    };
  },
);

// ---------------------------------------------------------------------------
// Breakdowns
// ---------------------------------------------------------------------------

export type MerchantPayoutsData = {
  top: { merchantId: string; name: string; amount: number }[];
  total: number;
  merchantsPaid: number;
};

// Top merchants by OUTGOING bank amount over the range. `total` includes
// outgoing transfers not (yet) matched to a merchant.
export const getMerchantPayouts = cache(
  async (fundId: string, months: number): Promise<MerchantPayoutsData> => {
    const from = rangeStartUtc(months);
    const [groups, all] = await Promise.all([
      prisma.bankTransaction.groupBy({
        by: ["merchantId"],
        where: {
          fundId,
          direction: "OUTGOING",
          occurredAt: { gte: from },
          merchantId: { not: null },
        },
        _sum: { amount: true },
        orderBy: { _sum: { amount: "desc" } },
      }),
      prisma.bankTransaction.aggregate({
        where: { fundId, direction: "OUTGOING", occurredAt: { gte: from } },
        _sum: { amount: true },
      }),
    ]);
    const topGroups = groups
      .filter((g): g is typeof g & { merchantId: string } => !!g.merchantId)
      .slice(0, 5);
    const merchants = topGroups.length
      ? await prisma.merchant.findMany({
          where: { fundId, id: { in: topGroups.map((g) => g.merchantId) } },
          select: { id: true, name: true },
        })
      : [];
    const names = new Map(merchants.map((m) => [m.id, m.name]));
    return {
      top: topGroups.map((g) => ({
        merchantId: g.merchantId,
        name: names.get(g.merchantId) ?? "—",
        amount: toNumber(g._sum.amount),
      })),
      total: toNumber(all._sum.amount),
      merchantsPaid: groups.length,
    };
  },
);

export const MEMBER_STATUS_ORDER = [
  "ACTIVE",
  "NEW",
  "PAUSED",
  "INACTIVE",
  "STOPPED",
  "REJECTED",
] as const;
export type DashboardMemberStatus = (typeof MEMBER_STATUS_ORDER)[number];

export const getMemberStatusCounts = cache(
  async (
    fundId: string,
  ): Promise<{ status: DashboardMemberStatus; count: number }[]> => {
    const groups = await prisma.member.groupBy({
      by: ["status"],
      where: { fundId },
      _count: { _all: true },
    });
    const byStatus = new Map(groups.map((g) => [g.status, g._count._all]));
    return MEMBER_STATUS_ORDER.map((status) => ({
      status,
      count: byStatus.get(status) ?? 0,
    })).filter((s) => s.count > 0);
  },
);

export const getAllocationTiers = cache(async (fundId: string) => {
  const tiers = await prisma.allocationTier.findMany({
    where: { fundId, archivedAt: null },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      name: true,
      minContribution: true,
      maxContribution: true,
      allocationAmount: true,
      _count: { select: { members: true } },
    },
  });
  return tiers.map((t) => ({
    id: t.id,
    name: t.name,
    min: toNumber(t.minContribution),
    max: toNumber(t.maxContribution),
    allocation: toNumber(t.allocationAmount),
    members: t._count.members,
  }));
});

// ---------------------------------------------------------------------------
// Recent activity
// ---------------------------------------------------------------------------

export const getRecentOperations = cache(async (fundId: string) => {
  const ops = await prisma.tokenOperation.findMany({
    where: { fundId },
    orderBy: { submittedAt: "desc" },
    take: 10,
    select: {
      id: true,
      type: true,
      status: true,
      amount: true,
      submittedAt: true,
      member: { select: { firstName: true, lastName: true } },
    },
  });
  return ops.map((op) => ({
    id: op.id,
    type: op.type,
    status: op.status,
    amount: toNumber(op.amount),
    submittedAt: op.submittedAt,
    memberName: op.member
      ? `${op.member.firstName} ${op.member.lastName}`.trim()
      : null,
  }));
});
