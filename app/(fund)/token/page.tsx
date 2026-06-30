// SPDX-License-Identifier: AGPL-3.0-or-later
import { Suspense } from "react";
import { Coins } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { Badge } from "@/components/ui/badge";
import { Tabs, resolveActiveTab } from "@/components/ui/tabs";
import { requireFundRole } from "@/services/auth/dal";
import { requireCurrentFund } from "@/services/fund/server";

import { HoldersTable } from "./holders-table";
import { ManualBurnButton, ManualMintButton } from "./manual-mint-burn";
import { TableSkeleton } from "./skeleton";
import { TotalSupplyBadge } from "./total-supply-badge";
import { TransfersTable } from "./transfers-table";

// Read-only on-chain explorer for the fund's community currency. Powered by
// Alchemy (Transfers API + Token Holders endpoint) — see services/alchemy.
//
// Per the routing convention everything that drives the page is in the URL:
//   ?tab=transfers|holders  — which table to show
//   ?cursor=<opaque>        — Alchemy pageKey for the active tab; absent
//                             means "first page" / newest
// The tab switcher (components/ui/tabs.tsx) rebuilds the query so switching
// naturally resets the cursor — desired behaviour because pageKeys are not
// portable across endpoints.

const TABS = [{ value: "transfers" }, { value: "holders" }] as const;

const CHAIN_LABELS: Record<number, string> = {
  100: "Gnosis",
  137: "Polygon",
  8453: "Base",
  10: "Optimism",
  42161: "Arbitrum",
  1: "Ethereum",
};

export default async function TokenExplorerPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; cursor?: string; page?: string }>;
}) {
  await requireFundRole("ADMIN");
  const t = await getTranslations("fund.token");
  const fund = await requireCurrentFund();
  const sp = await searchParams;
  const active = resolveActiveTab(sp.tab, TABS);
  const pageNum = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);

  const hasToken =
    Boolean(fund.tokenAddress) && typeof fund.tokenChainId === "number";

  return (
    <>
      <header className="space-y-3">
        <div className="flex items-start gap-3">
          {fund.tokenLogoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={fund.tokenLogoUrl}
              alt={fund.tokenName ? `${fund.tokenName} logo` : "Token logo"}
              className="size-10 rounded-full bg-muted object-contain ring-1 ring-foreground/10"
            />
          ) : (
            <div className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
              <Coins className="size-5" />
            </div>
          )}
          <div className="flex-1 space-y-0.5">
            <h1 className="font-heading text-2xl font-medium">
              {fund.tokenName ?? t("title")}
            </h1>
            <p className="text-sm text-muted-foreground">{t("description")}</p>
          </div>
          {hasToken && (
            <div className="flex shrink-0 items-center gap-2">
              <ManualMintButton symbol={fund.tokenSymbol} />
              <ManualBurnButton symbol={fund.tokenSymbol} />
            </div>
          )}
        </div>
        {hasToken && (
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {fund.tokenSymbol && (
              <Badge variant="outline">{fund.tokenSymbol}</Badge>
            )}
            {fund.tokenChainId != null && (
              <Badge variant="default">
                {CHAIN_LABELS[fund.tokenChainId] ?? `Chain #${fund.tokenChainId}`}
              </Badge>
            )}
            <Suspense
              fallback={
                <span className="inline-block h-4 w-24 animate-pulse rounded bg-muted" />
              }
            >
              <TotalSupplyBadge
                contractAddress={fund.tokenAddress!}
                chainId={fund.tokenChainId!}
                decimals={fund.tokenDecimals ?? 0}
                symbol={fund.tokenSymbol}
                label={t("supply")}
              />
            </Suspense>
            <span className="font-mono break-all text-muted-foreground">
              {fund.tokenAddress}
            </span>
          </div>
        )}
      </header>

      {!hasToken ? (
        <div className="rounded-lg border border-dashed bg-muted/30 p-6 text-sm text-muted-foreground">
          {t("notConnected")}
        </div>
      ) : (
        <>
          <Tabs
            active={active}
            items={TABS.map((tab) => ({
              value: tab.value,
              label: t(`tabs.${tab.value}`),
            }))}
          />

          {active === "transfers" && (
            <Suspense
              // Distinct key per cursor so React tears down the prior table
              // (and re-shows the skeleton) when the user pages forward.
              key={`transfers:${sp.cursor ?? ""}`}
              fallback={
                <TableSkeleton
                  columns={[
                    { label: t("transfers.date") },
                    { label: t("transfers.from") },
                    { width: "w-6" },
                    { label: t("transfers.to") },
                    { label: t("transfers.amount"), align: "right" },
                  ]}
                />
              }
            >
              <TransfersTable
                fund={{
                  id: fund.id,
                  citizenPayApiKeyId: fund.citizenPayApiKeyId,
                  citizenPayApiKeyEnc: fund.citizenPayApiKeyEnc,
                }}
                contractAddress={fund.tokenAddress!}
                chainId={fund.tokenChainId!}
                decimals={fund.tokenDecimals ?? 0}
                symbol={fund.tokenSymbol}
                minterEoa={fund.tokenMinterEoaAddress}
                minterSmartAccount={fund.tokenMinterSmartAccountAddress}
                cursor={sp.cursor ?? null}
              />
            </Suspense>
          )}
          {active === "holders" && (
            <Suspense
              key={`holders:${pageNum}`}
              fallback={
                <TableSkeleton
                  columns={[
                    { label: "#", width: "w-12" },
                    { label: t("holders.holder") },
                    { label: t("holders.balance"), align: "right" },
                  ]}
                />
              }
            >
              <HoldersTable
                fund={{
                  id: fund.id,
                  citizenPayApiKeyId: fund.citizenPayApiKeyId,
                  citizenPayApiKeyEnc: fund.citizenPayApiKeyEnc,
                }}
                contractAddress={fund.tokenAddress!}
                chainId={fund.tokenChainId!}
                decimals={fund.tokenDecimals ?? 0}
                symbol={fund.tokenSymbol}
                minterEoa={fund.tokenMinterEoaAddress}
                minterSmartAccount={fund.tokenMinterSmartAccountAddress}
                page={pageNum}
              />
            </Suspense>
          )}
        </>
      )}
    </>
  );
}
