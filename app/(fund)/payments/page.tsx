// SPDX-License-Identifier: AGPL-3.0-or-later
import { Suspense } from "react";
import { getTranslations } from "next-intl/server";

import { Tabs, resolveActiveTab } from "@/components/ui/tabs";
import { requireFundRole } from "@/services/auth/dal";
import { requireCurrentFund } from "@/services/fund/server";
import {
  CompletedPayoutsView,
  DraftsView,
  PendingPayoutsView,
} from "./payouts-section";
import { PayoutsSkeleton } from "./skeleton";

// Merchant payouts only. Member deposits (and their manual attribution)
// live on the Allocations screen; period assignment lives on the Bank
// screen.
const TABS = [
  { value: "drafts" },
  { value: "pending" },
  { value: "completed" },
] as const;

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  await requireFundRole("ADMIN");
  const t = await getTranslations("fund.payments");
  const fund = await requireCurrentFund();
  const sp = await searchParams;
  const active = resolveActiveTab(sp.tab, TABS);

  return (
    <>
      <header className="space-y-1">
        <h1 className="font-heading text-2xl font-medium">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </header>

      <Tabs
        active={active}
        items={TABS.map((tab) => ({
          value: tab.value,
          label: t(`tabs.${tab.value}`),
        }))}
      />

      {active === "drafts" && (
        <Suspense fallback={<PayoutsSkeleton />}>
          <DraftsView
            fundId={fund.id}
            citizenPayApiKeyId={fund.citizenPayApiKeyId}
            citizenPayApiKeyEnc={fund.citizenPayApiKeyEnc}
          />
        </Suspense>
      )}
      {active === "pending" && (
        <Suspense fallback={<PayoutsSkeleton />}>
          <PendingPayoutsView
            fundId={fund.id}
            citizenPayApiKeyId={fund.citizenPayApiKeyId}
            citizenPayApiKeyEnc={fund.citizenPayApiKeyEnc}
          />
        </Suspense>
      )}
      {active === "completed" && (
        <Suspense fallback={<PayoutsSkeleton />}>
          <CompletedPayoutsView
            fundId={fund.id}
            citizenPayApiKeyId={fund.citizenPayApiKeyId}
            citizenPayApiKeyEnc={fund.citizenPayApiKeyEnc}
          />
        </Suspense>
      )}
    </>
  );
}
