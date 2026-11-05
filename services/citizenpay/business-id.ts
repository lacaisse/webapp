// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";
import { cache } from "react";

import { prisma } from "@/services/db/prisma";

import { getCitizenPayClient, type FundCredentials } from "./client";

// The Citizen Pay business that operates the fund's treasury — its Ponto bank
// connection is the fund's open banking, and the CP dashboard's banking and
// billing pages live under its id (services/fund-setup/citizenpay-dashboard.ts).
//
// Prefers the cached `Fund.citizenPayBusinessId` column (written on connect and
// key rotation). When it's absent (funds connected before the column existed
// never populated it), this fetches the id live from CP and backfills the cache
// so the next render skips the round-trip. Returns null when the fund isn't
// connected (no API key, so CP isn't called) or CP has no business id —
// callers then link to the dashboard root.
//
// Cached per request (React `cache()`, keyed on the fund's columns rather than
// the object, which differs per call site): the dashboard checklist, the Bank
// page and the Subscription tab may all ask in one render — one CP read, one
// backfill write.
export async function resolveCitizenPayBusinessId(
  fund: FundCredentials & { citizenPayBusinessId: string | null },
): Promise<string | null> {
  return resolveCached(
    fund.id,
    fund.citizenPayApiKeyId,
    fund.citizenPayApiKeyEnc,
    fund.citizenPayBusinessId,
  );
}

const resolveCached = cache(
  async (
    id: string,
    citizenPayApiKeyId: string | null,
    citizenPayApiKeyEnc: string | null,
    citizenPayBusinessId: string | null,
  ): Promise<string | null> => {
    if (citizenPayBusinessId) return citizenPayBusinessId;
    if (!citizenPayApiKeyId) return null;

    let businessId: string | null = null;
    try {
      businessId = await getCitizenPayClient({
        id,
        citizenPayApiKeyId,
        citizenPayApiKeyEnc,
      }).getTreasuryBusinessId();
    } catch (e) {
      console.warn("[citizenpay] getTreasuryBusinessId failed", id, e);
      return null;
    }

    if (businessId) {
      try {
        await prisma.fund.update({
          where: { id },
          data: { citizenPayBusinessId: businessId },
        });
      } catch (e) {
        console.warn("[citizenpay] caching business id failed", id, e);
      }
    }
    return businessId;
  },
);
