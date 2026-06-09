// SPDX-License-Identifier: AGPL-3.0-or-later
import { Suspense } from "react";
import { getTranslations } from "next-intl/server";

import { Tabs, resolveActiveTab } from "@/components/ui/tabs";
import { requireCurrentFund } from "@/services/fund/server";

import { CardsSearch } from "./cards-search";
import { CardsTable } from "./cards-table";
import { CardSyncDialog } from "./sync-dialog";
import { NumberImportDialog } from "./number-import-dialog";
import { TableSkeleton } from "../token/skeleton";

const TABS = [
  { value: "all" },
  { value: "active" },
  { value: "lost" },
  { value: "blocked" },
] as const;

export default async function CardsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; page?: string; q?: string }>;
}) {
  const t = await getTranslations("fund.cards");
  const fund = await requireCurrentFund();
  const sp = await searchParams;
  const active = resolveActiveTab(sp.tab, TABS);
  const pageNum = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);
  const q = sp.q?.trim() || null;

  return (
    <>
      <header className="flex items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="font-heading text-2xl font-medium">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </div>
        <div className="flex items-center gap-2">
          <NumberImportDialog />
          <CardSyncDialog />
        </div>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          active={active}
          items={TABS.map((tab) => ({
            value: tab.value,
            label: t(`tabs.${tab.value}`),
          }))}
        />
        <CardsSearch placeholder={t("searchPlaceholder")} />
      </div>

      <Suspense
        // Distinct key per (tab, page, q) so React tears down the prior
        // table (and re-shows the skeleton) when the user pages forward,
        // switches tabs, or refines the search.
        key={`${active}:${pageNum}:${q ?? ""}`}
        fallback={
          <TableSkeleton
            columns={[
              { label: t("columns.number") },
              { label: t("columns.serial") },
              { label: t("columns.holder") },
              { label: t("columns.member") },
              { label: t("columns.status") },
              { label: t("columns.balance"), align: "right" },
              { label: t("columns.issued") },
              { width: "w-6" },
            ]}
          />
        }
      >
        <CardsTable
          fund={{
            id: fund.id,
            tokenAddress: fund.tokenAddress,
            tokenChainId: fund.tokenChainId,
            tokenDecimals: fund.tokenDecimals,
            tokenSymbol: fund.tokenSymbol,
          }}
          tab={active}
          page={pageNum}
          q={q}
        />
      </Suspense>
    </>
  );
}
