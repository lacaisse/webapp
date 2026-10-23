// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";
import { cache } from "react";

import { getCitizenPayClient } from "@/services/citizenpay/client";
import type { TreasuryStats } from "@/services/citizenpay/types";
import { prisma } from "@/services/db/prisma";

import {
  summariseContributions,
  summariseTransfers,
  type ContributionStats,
  type TransferTotals,
} from "./aggregate";

// Loaders for the fund Statistics page. Each is wrapped in React's `cache()`
// so the KPI row, the chart and the merchants card share one DB query / one
// CitizenPay round-trip per render, with primitive args (ISO strings, not
// Dates or the fund object) so `cache()` can key on them. The CitizenPay ones
// degrade to `error: true` instead of throwing, so an outage reads as "—" and
// a notice rather than as zero sales.
//
// Windows are half-open `[from, to)`; a null end is unbounded.

export type MerchantStatsData = { stats: TreasuryStats | null; error: boolean };
export type LocalMerchant = { id: string; name: string; citizenPayPlaceId: string };

function client(
  fundId: string,
  citizenPayApiKeyId: string | null,
  citizenPayApiKeyEnc: string | null,
) {
  return getCitizenPayClient({
    id: fundId,
    citizenPayApiKeyId,
    citizenPayApiKeyEnc,
  });
}

function toDate(iso: string | null): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function occurredIn(fromIso: string | null, toIso: string | null) {
  const from = toDate(fromIso);
  const to = toDate(toIso);
  return from || to
    ? {
        occurredAt: {
          ...(from ? { gte: from } : {}),
          ...(to ? { lt: to } : {}),
        },
      }
    : {};
}

// What came in: every INCOMING bank row in the window, matched to a member or
// not — the same definition as the dashboard's contributions
// (app/(fund)/dashboard/data.ts::getMonthMoneyKpis / getMoneySeries), so the
// two pages agree on any month they both show. The unmatched count travels
// with it, as on the dashboard, so the gap is visible rather than hidden.
export const getContributionStats = cache(
  async (
    fundId: string,
    fromIso: string | null,
    toIso: string | null,
  ): Promise<ContributionStats> => {
    const rows = await prisma.bankTransaction.findMany({
      where: {
        fundId,
        direction: "INCOMING",
        ...occurredIn(fromIso, toIso),
      },
      select: { amount: true, occurredAt: true, memberId: true },
    });
    return summariseContributions(rows);
  },
);

// What went out to merchants: every OUTGOING bank row in the window — the
// dashboard's "paid out" (getMonthMoneyKpis / getMerchantPayouts), i.e. the
// bank transfers that actually left the fund's account.
export const getPaidOutStats = cache(
  async (
    fundId: string,
    fromIso: string | null,
    toIso: string | null,
  ): Promise<TransferTotals> => {
    const rows = await prisma.bankTransaction.findMany({
      where: {
        fundId,
        direction: "OUTGOING",
        ...occurredIn(fromIso, toIso),
      },
      select: { amount: true, occurredAt: true },
    });
    return summariseTransfers(rows);
  },
);

// What members spent at merchants, per month and per place — CitizenPay's
// treasury statistics over the same window.
export const getMerchantStats = cache(
  async (
    fundId: string,
    citizenPayApiKeyId: string | null,
    citizenPayApiKeyEnc: string | null,
    fromIso: string | null,
    toIso: string | null,
  ): Promise<MerchantStatsData> => {
    try {
      const stats = await client(
        fundId,
        citizenPayApiKeyId,
        citizenPayApiKeyEnc,
      ).getStats({
        ...(fromIso ? { from: fromIso } : {}),
        ...(toIso ? { to: toIso } : {}),
      });
      return { stats, error: false };
    } catch (e) {
      console.warn("[statistics] getStats failed", e);
      return { stats: null, error: true };
    }
  },
);

// The fund's own merchant rows for a set of CitizenPay place ids, so the
// merchants table can link a place to its /merchants/[id] page. Scoped to the
// fund: a place id from another fund's treasury finds nothing here.
export async function getLocalMerchantsForPlaces(
  fundId: string,
  placeIds: string[],
): Promise<LocalMerchant[]> {
  if (placeIds.length === 0) return [];
  const rows = await prisma.merchant.findMany({
    where: { fundId, citizenPayPlaceId: { in: placeIds } },
    select: { id: true, name: true, citizenPayPlaceId: true },
  });
  return rows.flatMap((r) =>
    r.citizenPayPlaceId
      ? [{ id: r.id, name: r.name, citizenPayPlaceId: r.citizenPayPlaceId }]
      : [],
  );
}
