// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { after } from "next/server";

import type { AllocationMode } from "@/services/db/generated/enums";

import { getCitizenPayClient, type FundCredentials } from "./client";
import { isPublishableTopUpUrl, topUpUrlFor } from "./top-up-url";

export type TopUpUrlFund = FundCredentials & {
  domain: string;
  allocationMode: AllocationMode;
};

export type TopUpUrlSyncResult =
  | { status: "skipped"; reason: "not_connected" | "insecure_url" }
  | { status: "synced"; url: string | null }
  | { status: "failed"; url: string | null; error: unknown };

let warnedInsecure = false;

/**
 * Push the fund's top-up URL (see top-up-url.ts) to its CitizenPay treasury:
 * the contribution link for PAY_AND_GO and FIXED_PERIOD, null (clears the wallet's "Add funds"
 * button) otherwise. No-op for a fund that isn't connected to CP yet.
 *
 * Environment guard: against the live API, a URL that isn't https (a dev
 * server — `http://acme.localhost:3000/…` — pointed at a real CP) is never
 * pushed; the sync is skipped and logged once per process. The in-process
 * mock records whatever it's given.
 *
 * Best-effort: the wallet button is a convenience, saving the setting that
 * triggered the sync is not — so a CP failure is logged and reported in the
 * result, never thrown. Request paths should go through
 * `scheduleTreasuryTopUpUrlSync` rather than awaiting this.
 */
export async function syncTreasuryTopUpUrl(
  fund: TopUpUrlFund,
): Promise<TopUpUrlSyncResult> {
  if (!fund.citizenPayApiKeyId || !fund.citizenPayApiKeyEnc) {
    return { status: "skipped", reason: "not_connected" };
  }
  const url = topUpUrlFor(fund);
  const live = Boolean(process.env.CITIZENPAY_API_BASE_URL);
  if (live && !isPublishableTopUpUrl(url)) {
    if (!warnedInsecure) {
      console.warn(
        "[citizenpay] not pushing a non-https top-up URL to the live API (check NODE_ENV / APP_DOMAIN)",
        url,
      );
      warnedInsecure = true;
    }
    return { status: "skipped", reason: "insecure_url" };
  }
  try {
    await getCitizenPayClient(fund).setTreasuryTopUpUrl(url);
    return { status: "synced", url };
  } catch (error) {
    console.warn("[citizenpay] setTreasuryTopUpUrl failed", fund.id, error);
    return { status: "failed", url, error };
  }
}

/**
 * Run `syncTreasuryTopUpUrl` after the current response is sent (Next's
 * `after`), so a slow or hung CitizenPay never stalls a settings save or the
 * connect redirect. Call from a Server Function or Route Handler, after the
 * local write has landed. Never throws.
 */
export function scheduleTreasuryTopUpUrlSync(fund: TopUpUrlFund): void {
  try {
    after(async () => {
      await syncTreasuryTopUpUrl(fund);
    });
  } catch (e) {
    // `after` throws outside a request scope — nothing to defer to then.
    console.warn("[citizenpay] could not schedule top-up URL sync", fund.id, e);
  }
}
