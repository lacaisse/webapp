// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { CitizenPayApiError } from "@/services/citizenpay/api";
import { getCitizenPayClient } from "@/services/citizenpay/client";
import type { CitizenPayClient } from "@/services/citizenpay/client-interface";
import type { FeeWaiver } from "@/services/citizenpay/types";
import { prisma } from "@/services/db/prisma";

// Settings → Fees, "Businesses exempt from the fixed fee". The waivers live
// only on Citizen Pay (`/v2/treasury/fee-waivers`); La Caisse adds the names of
// its own merchants (places) of each business, and offers as candidates the
// fund's merchants grouped by business. Read server-side for the page; the
// add / remove server actions are in fee-waiver-actions.ts.

/** A business of this fund, as the card shows it. */
export type FeeWaiverBusiness = {
  businessId: string;
  // CP's business name for a waiver; "" for a candidate (not known locally).
  businessName: string;
  // Names of this fund's merchants (places) of that business, sorted.
  placeNames: string[];
};

export type FeeWaiverState =
  // Not connected to Citizen Pay (no treasury / no key): nothing to list.
  | { status: "not_connected" }
  // The api answers 404: it predates the fixed fee.
  | { status: "unavailable" }
  // Any other failure reading the list.
  | { status: "error" }
  | {
      status: "ok";
      waivers: FeeWaiverBusiness[];
      candidates: FeeWaiverBusiness[];
    };

type FundForWaivers = {
  id: string;
  citizenPayFundId: string | null;
  citizenPayApiKeyId: string | null;
  citizenPayApiKeyEnc: string | null;
};

/**
 * The fund's CP client, or null when the fund is not connected (no treasury
 * id, or live mode without a key — the factory throws then).
 */
export function feeWaiverClient(fund: FundForWaivers): CitizenPayClient | null {
  if (!fund.citizenPayFundId) return null;
  try {
    return getCitizenPayClient(fund);
  } catch {
    return null;
  }
}

/** businessId → sorted names of this fund's merchants of that business. */
export async function fundBusinessPlaces(fundId: string): Promise<Map<string, string[]>> {
  const merchants = await prisma.merchant.findMany({
    where: { fundId, citizenPayBusinessId: { not: null } },
    select: { name: true, citizenPayBusinessId: true },
    orderBy: { name: "asc" },
  });
  const byBusiness = new Map<string, string[]>();
  for (const m of merchants) {
    const id = m.citizenPayBusinessId?.trim();
    if (!id) continue;
    const names = byBusiness.get(id) ?? [];
    names.push(m.name);
    byBusiness.set(id, names);
  }
  return byBusiness;
}

/** True when one of THIS fund's merchants belongs to that CP business. */
export async function businessBelongsToFund(
  fundId: string,
  businessId: string,
): Promise<boolean> {
  const row = await prisma.merchant.findFirst({
    where: { fundId, citizenPayBusinessId: businessId },
    select: { id: true },
  });
  return row !== null;
}

export function isNotFound(e: unknown): boolean {
  return e instanceof CitizenPayApiError && e.status === 404;
}

/** Pure: merge CP's waivers with the local merchants. Exported for tests. */
export function buildFeeWaiverLists(
  waivers: FeeWaiver[],
  places: Map<string, string[]>,
): { waivers: FeeWaiverBusiness[]; candidates: FeeWaiverBusiness[] } {
  const waived = new Set(waivers.map((w) => w.businessId));
  const byName = (a: FeeWaiverBusiness, b: FeeWaiverBusiness) =>
    (a.businessName || a.placeNames[0] || a.businessId).localeCompare(
      b.businessName || b.placeNames[0] || b.businessId,
    );
  return {
    waivers: waivers
      .map((w) => ({
        businessId: w.businessId,
        businessName: w.businessName,
        placeNames: places.get(w.businessId) ?? [],
      }))
      .sort(byName),
    candidates: [...places.entries()]
      .filter(([id]) => !waived.has(id))
      .map(([businessId, placeNames]) => ({ businessId, businessName: "", placeNames }))
      .sort(byName),
  };
}

export async function loadFeeWaiverState(fund: FundForWaivers): Promise<FeeWaiverState> {
  const client = feeWaiverClient(fund);
  if (!client) return { status: "not_connected" };
  let waivers: FeeWaiver[];
  try {
    waivers = await client.listFeeWaivers();
  } catch (e) {
    if (isNotFound(e)) return { status: "unavailable" };
    console.error("[settings] fee waivers read failed", fund.id, e);
    return { status: "error" };
  }
  const places = await fundBusinessPlaces(fund.id);
  return { status: "ok", ...buildFeeWaiverLists(waivers, places) };
}
