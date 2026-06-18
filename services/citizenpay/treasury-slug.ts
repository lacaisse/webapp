// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { prisma } from "@/services/db/prisma";

import { getCitizenPayClient, type FundCredentials } from "./client";

// The fund's CitizenPay treasury slug — the `network` segment of a card's
// public tap URL (https://tap.citizenpay.xyz/card/<serial>?network=<slug>).
//
// Prefers the cached `Fund.citizenPayTreasurySlug` column. When it's absent
// (funds connected before the column existed never populated it), this fetches
// the slug live from CP and backfills the cache so the next send skips the
// round-trip. Returns null when the fund isn't connected or CP has no slug —
// callers then build a link without the `network` param.
export async function resolveTreasurySlug(
  fund: FundCredentials & { citizenPayTreasurySlug: string | null },
): Promise<string | null> {
  if (fund.citizenPayTreasurySlug) return fund.citizenPayTreasurySlug;

  let slug: string | null = null;
  try {
    slug = await getCitizenPayClient(fund).getTreasurySlug();
  } catch (e) {
    console.warn("[citizenpay] getTreasurySlug failed", fund.id, e);
    return null;
  }

  if (slug) {
    try {
      await prisma.fund.update({
        where: { id: fund.id },
        data: { citizenPayTreasurySlug: slug },
      });
    } catch (e) {
      console.warn("[citizenpay] caching treasury slug failed", fund.id, e);
    }
  }
  return slug;
}
