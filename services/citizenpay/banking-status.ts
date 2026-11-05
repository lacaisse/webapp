// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";
import { cache } from "react";

import { getCitizenPayClient } from "@/services/citizenpay/client";
import type { BankingStatus } from "@/services/citizenpay/types";

// What a failed read degrades to: "no bank connected", so callers can always
// render the connect step rather than a crash.
const NOT_CONNECTED: BankingStatus = {
  connected: false,
  status: "not_connected",
  accountReference: null,
  accountName: null,
  onboardingComplete: false,
  paymentInitiationEnabled: false,
  paymentInitiationRequested: false,
  paymentRequestsEnabled: false,
  ready: false,
};

// The treasury's bank-connection status as Citizen Pay reports it, or null
// when the read failed (logged). Non-degrading: the dashboard's setup
// checklist needs to tell "no bank" from "Citizen Pay didn't answer".
// Wrapped in `cache()` so every reader in one render — this and
// getBankingStatus below — shares a single CP call; never throws.
export const readBankingStatus = cache(
  async (
    fundId: string,
    citizenPayApiKeyId: string | null,
    citizenPayApiKeyEnc: string | null,
  ): Promise<BankingStatus | null> => {
    try {
      return await getCitizenPayClient({
        id: fundId,
        citizenPayApiKeyId,
        citizenPayApiKeyEnc,
      }).getBankingStatus();
    } catch (e) {
      console.warn("[bank] getBankingStatus failed", e);
      return null;
    }
  },
);

// Same read, degraded to "no bank connected" on failure. Used by the Bank
// page, the payout page and the cotisation page (re-exported from
// app/(fund)/bank/data.ts), which always render the connect step rather than
// a crash. Shares readBankingStatus's per-render cache; never throws.
export async function getBankingStatus(
  fundId: string,
  citizenPayApiKeyId: string | null,
  citizenPayApiKeyEnc: string | null,
): Promise<BankingStatus> {
  const status = await readBankingStatus(fundId, citizenPayApiKeyId, citizenPayApiKeyEnc);
  return status ?? { ...NOT_CONNECTED };
}
