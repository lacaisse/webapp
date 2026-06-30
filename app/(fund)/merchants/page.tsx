// SPDX-License-Identifier: AGPL-3.0-or-later
import { Suspense } from "react";
import { Plus } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { buttonVariants } from "@/components/ui/button";
import { Tabs, resolveActiveTab } from "@/components/ui/tabs";
import { requireFundRole } from "@/services/auth/dal";
import { requireCurrentFund } from "@/services/fund/server";

import { MerchantsTable } from "./merchants-table";
import { MerchantSyncDialog } from "./sync-dialog";
import { TableSkeleton } from "../token/skeleton";

const TABS = [
  { value: "pending" },
  { value: "active" },
  { value: "rejected" },
  { value: "inactive" },
] as const;

export default async function MerchantsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  await requireFundRole("ADMIN");
  const t = await getTranslations("fund.merchants");
  const fund = await requireCurrentFund();
  const sp = await searchParams;
  const active = resolveActiveTab(sp.tab, TABS);

  return (
    <>
      <header className="flex items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="font-heading text-2xl font-medium">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </div>
        <div className="flex items-center gap-2">
          <MerchantSyncDialog />
          <button type="button" className={buttonVariants({ variant: "default" })}>
            <Plus />
            {t("invite")}
          </button>
        </div>
      </header>

      <Tabs
        active={active}
        items={TABS.map((tab) => ({
          value: tab.value,
          label: t(`tabs.${tab.value}`),
        }))}
      />

      <Suspense
        // Distinct key per tab so React tears down the prior table (and
        // re-shows the skeleton) when switching tabs.
        key={active}
        fallback={
          <TableSkeleton
            columns={[
              { label: t("columns.name") },
              { label: t("columns.contact") },
              { label: t("columns.emailVerified") },
              { label: t("columns.citizenpay") },
              { label: t("columns.balance"), align: "right" },
              { label: t("columns.joined") },
              { width: "w-6" },
            ]}
          />
        }
      >
        <MerchantsTable
          fund={{
            id: fund.id,
            citizenPayApiKeyId: fund.citizenPayApiKeyId,
            citizenPayApiKeyEnc: fund.citizenPayApiKeyEnc,
            tokenSymbol: fund.tokenSymbol,
          }}
          tab={active}
        />
      </Suspense>
    </>
  );
}
