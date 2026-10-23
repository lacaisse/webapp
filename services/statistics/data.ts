// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";
import { cache } from "react";

import { getCitizenPayClient } from "@/services/citizenpay/client";
import type { TreasuryStats } from "@/services/citizenpay/types";
import { prisma } from "@/services/db/prisma";

import {
  payoutsInWindow,
  summariseContributions,
  summarisePayouts,
  type ContributionStats,
  type PayoutTotals,
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
export type PayoutStatsData = PayoutTotals & { error: boolean };
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

// What members put in: the fund's matched incoming bank deposits. Unmatched
// deposits (no member yet) are left out — until someone attributes them they
// aren't a member's contribution, and the bank page is where they get fixed.
export const getContributionStats = cache(
  async (
    fundId: string,
    fromIso: string | null,
    toIso: string | null,
  ): Promise<ContributionStats> => {
    const from = toDate(fromIso);
    const to = toDate(toIso);
    const rows = await prisma.bankTransaction.findMany({
      where: {
        fundId,
        direction: "INCOMING",
        memberId: { not: null },
        ...(from || to
          ? {
              occurredAt: {
                ...(from ? { gte: from } : {}),
                ...(to ? { lt: to } : {}),
              },
            }
          : {}),
      },
      select: { amount: true, occurredAt: true, memberId: true },
    });
    return summariseContributions(rows);
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

// What merchants were paid out. Only completed payouts count: a payout is
// "paid out" once it was created AND its settlement ran, so pending ones
// (bank signature outstanding, burn not done) stay out of the figure. It is
// placed in time by `createdAt` — the moment the admin committed to paying
// it — because the list rows carry no settlement timestamp (`updatedAt` moves
// on any later edit, e.g. a fee sweep). The amount is `net`, what the
// merchant actually receives after fees and deductions.
//
// CitizenPay has no date filter on this list, so the window is applied here.
export const getPayoutStats = cache(
  async (
    fundId: string,
    citizenPayApiKeyId: string | null,
    citizenPayApiKeyEnc: string | null,
    fromIso: string | null,
    toIso: string | null,
  ): Promise<PayoutStatsData> => {
    try {
      const payouts = await client(
        fundId,
        citizenPayApiKeyId,
        citizenPayApiKeyEnc,
      ).listCompletedPayouts();
      const kept = payoutsInWindow(payouts, toDate(fromIso), toDate(toIso));
      return { ...summarisePayouts(kept), error: false };
    } catch (e) {
      console.warn("[statistics] listCompletedPayouts failed", e);
      return { total: "0.00", count: 0, months: [], error: true };
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
