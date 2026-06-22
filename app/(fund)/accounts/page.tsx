// SPDX-License-Identifier: AGPL-3.0-or-later
import { Suspense } from "react";
import { Info } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { shortAddress } from "@/services/alchemy/format";
import { requireCurrentFund } from "@/services/fund/server";

import { CreateAccountDialog } from "./create-account-dialog";
import { getTokenAccounts } from "./data";
import { AccountsTableSkeleton } from "./skeleton";

// Synchronous shell: the header (with its create CTA) and the balance table
// (Alchemy-backed, slow) each stream behind their own <Suspense>.
export default function AccountsPage() {
  return (
    <div className="space-y-6">
      <Suspense fallback={<AccountsHeaderFallback />}>
        <AccountsHeader />
      </Suspense>
      <Suspense fallback={<AccountsTableSkeleton />}>
        <AccountsTable />
      </Suspense>
    </div>
  );
}

async function AccountsHeader() {
  const t = await getTranslations("fund.accounts");
  const fund = await requireCurrentFund();

  // Deriving a new account needs the minter EOA + CP's Safe factory.
  const canCreate = Boolean(
    fund.tokenMinterEoaAddress && fund.citizenPayAccountFactoryAddress,
  );

  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="font-heading text-2xl font-medium">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </div>
        {canCreate && <CreateAccountDialog />}
      </header>

      {!canCreate && (
        <Alert>
          <Info className="size-4" />
          <AlertDescription>{t("notConnected")}</AlertDescription>
        </Alert>
      )}
    </>
  );
}

async function AccountsTable() {
  const t = await getTranslations("fund.accounts");
  const fund = await requireCurrentFund();

  const token = {
    tokenAddress: fund.tokenAddress,
    tokenChainId: fund.tokenChainId,
    tokenDecimals: fund.tokenDecimals,
  };
  const { accounts, balancesError } = await getTokenAccounts(fund.id, token);

  return (
    <>
      {balancesError && (
        <Alert variant="warning">
          <AlertDescription>{t("balancesError")}</AlertDescription>
        </Alert>
      )}

      {accounts.length === 0 ? (
        <div className="rounded-lg border border-border py-12 text-center text-sm text-muted-foreground">
          {t("empty")}
        </div>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("table.name")}</TableHead>
              <TableHead>{t("table.address")}</TableHead>
              <TableHead>{t("table.serial")}</TableHead>
              <TableHead className="text-right">{t("table.balance")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {accounts.map((a) => (
              <TableRow key={a.id}>
                <TableCell>
                  <Link
                    href={`/accounts/${a.id}`}
                    className="font-medium hover:underline"
                  >
                    {a.name || t("defaultName")}
                  </Link>
                  {a.saltNonce === 0 && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      {t("defaultBadge")}
                    </span>
                  )}
                  {a.kind === "SOURCE" && (
                    <span className="ml-2 rounded-sm bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      {t("sourceBadge")}
                    </span>
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {shortAddress(a.address)}
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {a.serial ?? "—"}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {a.balance == null
                    ? "—"
                    : `${a.balance}${fund.tokenSymbol ? ` ${fund.tokenSymbol}` : ""}`}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </>
  );
}

function AccountsHeaderFallback() {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-1">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-72" />
      </div>
      <Skeleton className="h-9 w-32" />
    </header>
  );
}
