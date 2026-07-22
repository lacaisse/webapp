// SPDX-License-Identifier: AGPL-3.0-or-later
import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { buttonVariants } from "@/components/ui/button";
import { requireFundRole } from "@/services/auth/dal";
import { requireCurrentFund } from "@/services/fund/server";

import { TableSkeleton } from "../../skeleton";
import { AccountAudit } from "./account-audit";

// Balance audit for one wallet: why does this account hold what it holds?
// Loads the account's full transfer history and walks the running balance
// backwards from the current on-chain balance, so every row answers "what did
// this transfer do to the balance". Reached by clicking any address in the
// token explorer; counterparties here link onward to their own audit page, so
// an investigation is just a chain of clicks — and each step is a URL that
// back/forward and sharing preserve.
//
//   /token/account/0x…?page=N — pagination over the (locally sliced) history

const ADDRESS_RE = /^0x[a-f0-9]{40}$/;

export default async function TokenAccountAuditPage({
  params,
  searchParams,
}: {
  params: Promise<{ address: string }>;
  searchParams: Promise<{ page?: string }>;
}) {
  await requireFundRole("ADMIN");
  const t = await getTranslations("fund.token.account");
  const tToken = await getTranslations("fund.token");
  const fund = await requireCurrentFund();
  const { address } = await params;
  const sp = await searchParams;

  const account = address.toLowerCase();
  if (!ADDRESS_RE.test(account)) notFound();

  const pageNum = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);
  const hasToken =
    Boolean(fund.tokenAddress) && typeof fund.tokenChainId === "number";

  return (
    <>
      <header className="space-y-2">
        <Link
          href="/token"
          className={buttonVariants({ variant: "ghost", size: "sm" })}
        >
          <ArrowLeft className="size-3.5" />
          {t("back")}
        </Link>
        <h1 className="font-heading text-2xl font-medium">{t("title")}</h1>
        <p className="font-mono text-sm break-all text-muted-foreground">
          {account}
        </p>
      </header>

      {!hasToken ? (
        <div className="rounded-lg border border-dashed bg-muted/30 p-6 text-sm text-muted-foreground">
          {tToken("notConnected")}
        </div>
      ) : (
        <Suspense
          // Re-key per page so the skeleton re-shows while a new slice loads.
          key={`audit:${account}:${pageNum}`}
          fallback={<AuditSkeleton />}
        >
          <AccountAudit
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
            account={account}
            page={pageNum}
          />
        </Suspense>
      )}
    </>
  );
}

function AuditSkeleton() {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-2 rounded-lg border p-4">
            <span className="block h-3 w-20 animate-pulse rounded bg-muted" />
            <span className="block h-5 w-28 animate-pulse rounded bg-muted" />
          </div>
        ))}
      </div>
      <TableSkeleton
        columns={[
          { label: "" },
          { label: "" },
          { label: "", align: "right" },
          { label: "", align: "right" },
          { label: "" },
          { label: "" },
        ]}
      />
    </div>
  );
}
