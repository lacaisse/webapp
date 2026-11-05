// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";
import { cache } from "react";

import { readBankingStatus } from "@/services/citizenpay/banking-status";
import { resolveCitizenPayBusinessId } from "@/services/citizenpay/business-id";

import {
  citizenPayDashboardUrls,
  normaliseDashboardBaseUrl,
  type CitizenPayDashboardUrls,
} from "./citizenpay-dashboard";
import {
  deriveSetupSteps,
  isCitizenPayConnected,
  isSetupComplete,
  type BankingRead,
  type SetupStep,
} from "./steps";

// Server data layer for the fund-setup checklist (dashboard card, /bank CTA).
// The pure rules live in ./steps.ts and ./citizenpay-dashboard.ts; this module
// adds the env and the Citizen Pay reads (banking status, business id).

// Links into the Citizen Pay dashboard for the fund's business, against the
// configured dashboard (CITIZENPAY_DASHBOARD_URL, default my.citizenpay.xyz).
export function getCitizenPayDashboardUrls(
  businessId: string | null,
): CitizenPayDashboardUrls {
  return citizenPayDashboardUrls(
    normaliseDashboardBaseUrl(process.env.CITIZENPAY_DASHBOARD_URL),
    businessId,
  );
}

export type FundSetup = {
  steps: SetupStep[];
  complete: boolean;
  // Hosting is free for this fund (waiver code redeemed or set by a platform
  // admin): the subscription step is done without an acceptance.
  waived: boolean;
  // `not_read` when the fund isn't connected to Citizen Pay, `unavailable`
  // when Citizen Pay was asked and didn't answer.
  banking: BankingRead;
  urls: CitizenPayDashboardUrls;
};

export type FundSetupInput = {
  id: string;
  citizenPayFundId: string | null;
  citizenPayApiKeyId: string | null;
  citizenPayApiKeyEnc: string | null;
  citizenPayBusinessId: string | null;
  subscriptionAcceptedAt: Date | null;
  subscriptionWaivedAt: Date | null;
};

async function readBanking(fund: FundSetupInput): Promise<BankingRead> {
  // An unconnected fund has no API key to read with — don't call Citizen Pay
  // (in live mode the client would throw on the missing credentials anyway).
  if (!isCitizenPayConnected(fund)) return { kind: "not_read" };
  const status = await readBankingStatus(
    fund.id,
    fund.citizenPayApiKeyId,
    fund.citizenPayApiKeyEnc,
  );
  return status ? { kind: "ok", status } : { kind: "unavailable" };
}

async function loadFundSetup(fund: FundSetupInput): Promise<FundSetup> {
  // Both reads hit Citizen Pay only when needed: the business id is cached on
  // the fund after the first backfill, and an unconnected fund reads neither.
  const [banking, businessId] = await Promise.all([
    readBanking(fund),
    resolveCitizenPayBusinessId(fund),
  ]);
  const steps = deriveSetupSteps({
    citizenPayFundId: fund.citizenPayFundId,
    citizenPayApiKeyId: fund.citizenPayApiKeyId,
    banking,
    subscriptionAcceptedAt: fund.subscriptionAcceptedAt,
    subscriptionWaivedAt: fund.subscriptionWaivedAt,
  });
  return {
    steps,
    complete: isSetupComplete(steps),
    waived: fund.subscriptionWaivedAt != null,
    banking,
    urls: getCitizenPayDashboardUrls(businessId),
  };
}

// Cached per render. `cache()` keys on argument identity, so callers pass the
// fund object from `requireCurrentFund()` (itself cached → same reference).
export const getFundSetup = cache(loadFundSetup);
