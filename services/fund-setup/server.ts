// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";
import { cache } from "react";

import { readBankingStatus } from "@/services/citizenpay/banking-status";
import { resolveCitizenPayBusinessId } from "@/services/citizenpay/business-id";
import { prisma } from "@/services/db/prisma";

import { citizenPayDashboardUrls, type CitizenPayDashboardUrls } from "./citizenpay-dashboard";
import {
  SETUP_STEP_KEYS,
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
// configured dashboard (CITIZENPAY_DASHBOARD_URL, raw: the pure helper owns
// the trimming and the default my.citizenpay.xyz).
export function getCitizenPayDashboardUrls(
  businessId: string | null,
): CitizenPayDashboardUrls {
  return citizenPayDashboardUrls(process.env.CITIZENPAY_DASHBOARD_URL, businessId);
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
  setupCompletedAt: Date | null;
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
  // Settled once: after the first render that found every step done, the
  // checklist never calls Citizen Pay again for this fund (the dashboard is
  // the hot path; the Bank page keeps its own live read).
  if (fund.setupCompletedAt) {
    return {
      steps: SETUP_STEP_KEYS.map((key) => ({ key, status: "done" as const })),
      complete: true,
      waived: fund.subscriptionWaivedAt != null,
      banking: { kind: "not_read" },
      urls: getCitizenPayDashboardUrls(fund.citizenPayBusinessId),
    };
  }

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
  const complete = isSetupComplete(steps);
  if (complete) {
    // Remember it (best-effort, conditional so concurrent renders write once).
    try {
      await prisma.fund.updateMany({
        where: { id: fund.id, setupCompletedAt: null },
        data: { setupCompletedAt: new Date() },
      });
    } catch (e) {
      console.warn("[fund-setup] recording setupCompletedAt failed", fund.id, e);
    }
  }
  return {
    steps,
    complete,
    waived: fund.subscriptionWaivedAt != null,
    banking,
    urls: getCitizenPayDashboardUrls(businessId),
  };
}

// Cached per render. `cache()` keys on argument identity, so callers pass the
// fund object from `requireCurrentFund()` (itself cached → same reference).
export const getFundSetup = cache(loadFundSetup);
