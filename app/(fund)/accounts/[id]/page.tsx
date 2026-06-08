// SPDX-License-Identifier: AGPL-3.0-or-later
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { requireCurrentFund } from "@/services/fund/server";

import { AccountManage } from "./account-manage";
import { MoveTokensDialog } from "./move-tokens-dialog";
import { TransferDialog } from "./transfer-dialog";
import { TransfersTable } from "./transfers-table";

import {
  getAccountBalance,
  getAccountOptions,
  getAccountTransfersFirstPage,
  getTokenAccount,
} from "../data";

export default async function AccountDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const t = await getTranslations("fund.accounts");
  const fund = await requireCurrentFund();

  const account = await getTokenAccount(fund.id, id);
  if (!account) notFound();

  const token = {
    tokenAddress: fund.tokenAddress,
    tokenChainId: fund.tokenChainId,
    tokenDecimals: fund.tokenDecimals,
  };
  const balance = await getAccountBalance(account.address, token);
  const first = await getAccountTransfersFirstPage(
    fund.id,
    token,
    account.address,
  );
  const otherAccounts = (await getAccountOptions(fund.id, account.id)).map(
    (a) => ({ ...a, name: a.name || t("defaultName") }),
  );

  const isDefault = account.saltNonce === 0;
  const displayName = account.name || t("defaultName");

  // Address → name for the transfer table, so a counterparty that's another
  // fund account shows its name instead of a raw hash. Include this account
  // too (covers self-transfers / mints back to it).
  const accountNames: Record<string, string> = {
    [account.address.toLowerCase()]: displayName,
  };
  for (const a of otherAccounts) {
    accountNames[a.address.toLowerCase()] = a.name;
  }

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/accounts"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" />
          {t("detail.back")}
        </Link>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="font-heading text-2xl font-medium">{displayName}</h1>
          <p className="font-mono text-xs break-all text-muted-foreground">
            {account.address}
          </p>
        </div>
        <AccountManage
          id={account.id}
          name={account.name}
          canArchive={!isDefault}
        />
      </header>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-border p-3">
          <div className="text-xs text-muted-foreground">
            {t("detail.balance")}
          </div>
          <div className="mt-1 text-lg font-medium tabular-nums">
            {balance == null
              ? "—"
              : `${balance}${fund.tokenSymbol ? ` ${fund.tokenSymbol}` : ""}`}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          <MoveTokensDialog
            id={account.id}
            mode="in"
            symbol={fund.tokenSymbol}
          />
          <MoveTokensDialog
            id={account.id}
            mode="out"
            symbol={fund.tokenSymbol}
          />
          <TransferDialog
            id={account.id}
            accounts={otherAccounts}
            symbol={fund.tokenSymbol}
          />
        </div>
      </div>

      <section className="space-y-3">
        <h2 className="font-heading text-lg font-medium">
          {t("transfers.title")}
        </h2>
        {first.error && (
          <Alert variant="warning">
            <AlertDescription>{t("transfers.loadError")}</AlertDescription>
          </Alert>
        )}
        <TransfersTable
          id={account.id}
          initial={first.transfers}
          initialCursor={first.nextCursor}
          symbol={fund.tokenSymbol}
          accountNames={accountNames}
        />
      </section>
    </div>
  );
}
