// SPDX-License-Identifier: AGPL-3.0-or-later
import { Suspense } from "react";
import { Check, Info, Landmark, X } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requireCurrentFund } from "@/services/fund/server";
import { cn } from "@/lib/utils";

import { getBankBalance, getBankingStatus } from "./data";
import { DateRangeFilter } from "./date-range-filter";
import { BankFullSync } from "./full-sync";
import { DEFAULT_RANGE, isRangePreset } from "./range";
import { BankTransactionsTable } from "./transactions-table";

export default async function BankPage({
  searchParams,
}: {
  searchParams: Promise<{
    range?: string;
    from?: string;
    to?: string;
    page?: string;
  }>;
}) {
  const t = await getTranslations("fund.bank");
  const fund = await requireCurrentFund();

  const sp = await searchParams;
  const range = isRangePreset(sp.range) ? sp.range : DEFAULT_RANGE;
  const from = sp.from ?? "";
  const to = sp.to ?? "";
  const page = Math.max(1, Number.parseInt(sp.page ?? "1", 10) || 1);
  // Allocation periods only exist for FIXED_PERIOD funds — the Period
  // column/picker is hidden for the other modes.
  const showPeriod = fund.allocationMode === "FIXED_PERIOD";

  return (
    <>
      <header className="space-y-1">
        <h1 className="font-heading text-2xl font-medium">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </header>

      <Suspense fallback={<StatusSkeleton />}>
        <ConnectionStatus
          fundId={fund.id}
          citizenPayApiKeyId={fund.citizenPayApiKeyId}
          citizenPayApiKeyEnc={fund.citizenPayApiKeyEnc}
        />
      </Suspense>

      <Suspense fallback={null}>
        <BalanceCard
          fundId={fund.id}
          citizenPayApiKeyId={fund.citizenPayApiKeyId}
          citizenPayApiKeyEnc={fund.citizenPayApiKeyEnc}
        />
      </Suspense>

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-medium">{t("transactions.title")}</h2>
          <BankFullSync connected={Boolean(fund.citizenPayFundId)} />
        </div>
        <DateRangeFilter range={range} from={from} to={to} />
        <Suspense
          // Re-show the skeleton when the range or page changes.
          key={`${range}:${from}:${to}:${page}`}
          fallback={<TransactionsSkeleton columns={showPeriod ? 6 : 5} />}
        >
          <BankTransactionsTable
            fundId={fund.id}
            range={range}
            from={from || undefined}
            to={to || undefined}
            page={page}
            showPeriod={showPeriod}
          />
        </Suspense>
      </section>
    </>
  );
}

async function BalanceCard({
  fundId,
  citizenPayApiKeyId,
  citizenPayApiKeyEnc,
}: {
  fundId: string;
  citizenPayApiKeyId: string | null;
  citizenPayApiKeyEnc: string | null;
}) {
  const t = await getTranslations("fund.bank.balance");
  const format = await getFormatter();
  const balance = await getBankBalance(
    fundId,
    citizenPayApiKeyId,
    citizenPayApiKeyEnc,
  );
  if (!balance) return null;

  const money = (v: number | null) =>
    v == null
      ? "—"
      : format.number(v, { style: "currency", currency: balance.currency });

  return (
    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-2">
      <div className="rounded-lg border border-border p-3">
        <dt className="text-xs text-muted-foreground">{t("available")}</dt>
        <dd className="mt-1 text-lg font-medium tabular-nums">
          {money(balance.availableBalance)}
        </dd>
      </div>
      <div className="rounded-lg border border-border p-3">
        <dt className="text-xs text-muted-foreground">{t("current")}</dt>
        <dd className="mt-1 text-lg font-medium tabular-nums">
          {money(balance.currentBalance)}
        </dd>
      </div>
    </dl>
  );
}

function TransactionsSkeleton({ columns }: { columns: number }) {
  const last = columns - 1;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {Array.from({ length: columns }).map((_, i) => (
            <TableHead key={i} className={i === last ? "text-right" : undefined}>
              <span className="inline-block h-3.5 w-16 animate-pulse rounded bg-muted" />
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {Array.from({ length: 6 }).map((_, r) => (
          <TableRow key={r}>
            {Array.from({ length: columns }).map((_, i) => (
              <TableCell
                key={i}
                className={i === last ? "text-right" : undefined}
              >
                <span
                  className={cn(
                    "inline-block h-3.5 animate-pulse rounded bg-muted",
                    i === last ? "w-16" : "w-28",
                  )}
                />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

async function ConnectionStatus({
  fundId,
  citizenPayApiKeyId,
  citizenPayApiKeyEnc,
}: {
  fundId: string;
  citizenPayApiKeyId: string | null;
  citizenPayApiKeyEnc: string | null;
}) {
  const t = await getTranslations("fund.bank");
  const status = await getBankingStatus(
    fundId,
    citizenPayApiKeyId,
    citizenPayApiKeyEnc,
  );

  return (
    <section className="space-y-4 rounded-lg border border-border p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
            <Landmark className="size-5" />
          </div>
          <div className="space-y-0.5">
            <div className="font-medium">
              {status.accountName ?? t("status.noAccount")}
            </div>
            {status.accountReference && (
              <div className="font-mono text-xs text-muted-foreground">
                {status.accountReference}
              </div>
            )}
          </div>
        </div>
        <Badge variant={status.ready ? "success" : "warning"}>
          {status.ready ? t("status.ready") : t("status.notReady")}
        </Badge>
      </div>

      <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
        <Capability ok={status.connected} label={t("flags.connected")} />
        <Capability
          ok={status.onboardingComplete}
          label={t("flags.onboardingComplete")}
        />
        <Capability
          ok={status.paymentInitiationEnabled}
          label={t("flags.paymentInitiationEnabled")}
        />
        <Capability
          ok={status.paymentRequestsEnabled}
          label={t("flags.paymentRequestsEnabled")}
        />
      </dl>

      {!status.ready && (
        <Alert>
          <Info className="size-4" />
          <AlertDescription>
            {status.connected
              ? t("notice.activate")
              : t("notice.connect")}
          </AlertDescription>
        </Alert>
      )}
    </section>
  );
}

function Capability({ ok, label }: { ok: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <span
        className={cn(
          "flex size-4 shrink-0 items-center justify-center rounded-full",
          ok ? "bg-success/15 text-success" : "bg-muted text-muted-foreground",
        )}
      >
        {ok ? <Check className="size-3" /> : <X className="size-3" />}
      </span>
      <span className={ok ? undefined : "text-muted-foreground"}>{label}</span>
    </div>
  );
}

function StatusSkeleton() {
  return (
    <section className="space-y-4 rounded-lg border border-border p-5">
      <div className="flex items-center gap-3">
        <span className="size-10 animate-pulse rounded-full bg-muted" />
        <div className="space-y-1.5">
          <span className="block h-4 w-40 animate-pulse rounded bg-muted" />
          <span className="block h-3 w-28 animate-pulse rounded bg-muted" />
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <span key={i} className="h-4 w-44 animate-pulse rounded bg-muted" />
        ))}
      </div>
    </section>
  );
}
