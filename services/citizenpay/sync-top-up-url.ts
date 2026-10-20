// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import type { AllocationMode } from "@/services/db/generated/enums";

import { getCitizenPayClient, type FundCredentials } from "./client";
import { topUpUrlFor } from "./top-up-url";

export type TopUpUrlFund = FundCredentials & {
  domain: string;
  allocationMode: AllocationMode;
};

export type TopUpUrlSyncResult =
  | { status: "skipped" }
  | { status: "synced"; url: string | null }
  | { status: "failed"; url: string | null; error: unknown };

/**
 * Push the fund's top-up URL (see top-up-url.ts) to its CitizenPay treasury:
 * the contribution link for PAY_AND_GO, null (clears the wallet's "Add funds"
 * button) otherwise. No-op for a fund that isn't connected to CP yet.
 *
 * Best-effort: the wallet button is a convenience, saving the setting that
 * triggered the sync is not — so a CP failure is logged and reported in the
 * result, never thrown. Call it after the local write has landed.
 */
export async function syncTreasuryTopUpUrl(
  fund: TopUpUrlFund,
): Promise<TopUpUrlSyncResult> {
  if (!fund.citizenPayApiKeyId || !fund.citizenPayApiKeyEnc) {
    return { status: "skipped" };
  }
  const url = topUpUrlFor(fund);
  try {
    await getCitizenPayClient(fund).setTreasuryTopUpUrl(url);
    return { status: "synced", url };
  } catch (error) {
    console.warn("[citizenpay] setTreasuryTopUpUrl failed", fund.id, error);
    return { status: "failed", url, error };
  }
}
