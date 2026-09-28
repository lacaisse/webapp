// SPDX-License-Identifier: AGPL-3.0-or-later
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";

import { BarChart, type ValueFormat } from "@/components/charts/bar-chart";
import { RankedBars } from "@/components/charts/ranked-bars";
import { StatusBreakdown } from "@/components/charts/status-breakdown";
import { Sensitive } from "@/components/privacy/sensitive";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, resolveActiveTab } from "@/components/ui/tabs";
import { requireFundRole } from "@/services/auth/dal";
import { isFundAdmin } from "@/services/auth/roles";
import { requireCurrentFund } from "@/services/fund/server";
import { cn } from "@/lib/utils";

import {
  RANGE_MONTHS,
  getAllocationHealth,
  getAllocationTiers,
  getCirculation,
  getMemberKpis,
  getMemberSeries,
  getMemberStatusCounts,
  getMerchantHoldings,
  getMerchantKpis,
  getMerchantPayouts,
  getMoneySeries,
  getMonthMoneyKpis,
  getRecentOperations,
  type DashboardRange,
  type MonthlySeries,
} from "./data";
import {
  ActivitySkeleton,
  BreakdownCardSkeleton,
  ChartCardSkeleton,
  DashboardHeaderSkeleton,
  FooterSkeleton,
  KpiTileSkeleton,
} from "./skeleton";

// Fund analytics dashboard for the board: member + merchant activity, fund
// balance and money flows at a glance. Every section streams in its own
// Suspense boundary and degrades to "—" / an empty state when its source
// (Alchemy, CitizenPay, bank feed) is missing or down.
//
// URL state: ?range=3m|6m|12m (default 12m) drives the time-series charts and
// the range-scoped figures (payouts ranking, failed allocations).

// Listed in display order; resolved against the reversed list so an absent /
// unknown value falls back to 12m.
const RANGE_ITEMS = [
  { value: "3m" },
  { value: "6m" },
  { value: "12m" },
] as const satisfies readonly { value: DashboardRange }[];

const SERIES_1 = "var(--chart-1)";
const SERIES_2 = "var(--chart-4)";

// The dashboard surfaces fund-wide financials → ADMIN-only. An OPERATOR who
// lands here (it's the first nav item / default home) is bounced to /members,
// a page they can actually use, rather than /unauthorized.
export default async function FundDashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string | string[] }>;
}) {
  const { membership } = await requireFundRole("OPERATOR");
  if (!isFundAdmin(membership.role)) redirect("/members");

  const sp = await searchParams;
  const range = resolveActiveTab(sp.range, [...RANGE_ITEMS].reverse());
  const months = RANGE_MONTHS[range];

  return (
    <>
      <Suspense fallback={<DashboardHeaderSkeleton />}>
        <DashboardHeader range={range} />
      </Suspense>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Suspense fallback={<KpiTileSkeleton />}>
          <CirculationTile />
        </Suspense>
        <Suspense fallback={<KpiTileSkeleton count={3} />}>
          <ActivityTiles />
        </Suspense>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Suspense fallback={<KpiTileSkeleton count={2} />}>
          <MonthFlowTiles />
        </Suspense>
        <Suspense fallback={<KpiTileSkeleton />}>
          <HoldingsTile />
        </Suspense>
        <Suspense fallback={<KpiTileSkeleton />}>
          <PendingTile months={months} />
        </Suspense>
      </section>

      <section className="grid gap-3 lg:grid-cols-2">
        <Suspense fallback={<ChartCardSkeleton legend />}>
          <MoneyChart months={months} />
        </Suspense>
        <Suspense fallback={<ChartCardSkeleton />}>
          <MembersChart months={months} />
        </Suspense>
      </section>

      <section className="grid gap-3 lg:grid-cols-2">
        <Suspense fallback={<BreakdownCardSkeleton />}>
          <MerchantPayoutsCard months={months} />
        </Suspense>
        <Suspense fallback={<BreakdownCardSkeleton />}>
          <MembersByStatusCard />
        </Suspense>
      </section>

      <Suspense fallback={<ActivitySkeleton />}>
        <RecentActivity />
      </Suspense>

      <Suspense fallback={<FooterSkeleton />}>
        <CitizenPayFooter />
      </Suspense>
    </>
  );
}

// ---------------------------------------------------------------------------
// Shared formatting
// ---------------------------------------------------------------------------

async function getFormatters() {
  const [t, format, fund] = await Promise.all([
    getTranslations("fund.dashboard"),
    getFormatter(),
    requireCurrentFund(),
  ]);
  const symbol = fund.tokenSymbol ?? t("tokenFallback");
  return {
    t,
    format,
    fund,
    symbol,
    eur: (n: number) =>
      format.number(n, { style: "currency", currency: "EUR" }),
    tokens: (n: number) =>
      `${format.number(n, { maximumFractionDigits: 2 })} ${symbol}`,
    count: (n: number) => format.number(n),
  };
}

async function chartData(series: MonthlySeries) {
  const format = await getFormatter();
  return series.months.map((iso, i) => {
    const d = new Date(iso);
    return {
      label: format.dateTime(d, { month: "short", timeZone: "UTC" }),
      fullLabel: format.dateTime(d, {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      }),
      values: series.values.map((v) => v[i] ?? 0),
    };
  });
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

async function DashboardHeader({ range }: { range: DashboardRange }) {
  const t = await getTranslations("fund.dashboard");
  return (
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div className="space-y-1">
        <h1 className="font-heading text-2xl font-medium">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>
      <Tabs
        paramName="range"
        active={range}
        items={RANGE_ITEMS.map((r) => ({
          value: r.value,
          label: t(`range.${r.value}`),
        }))}
      />
    </header>
  );
}

// ---------------------------------------------------------------------------
// KPI tiles
// ---------------------------------------------------------------------------

async function CirculationTile() {
  const { t, fund, tokens } = await getFormatters();
  const circ = await getCirculation(
    fund.id,
    fund.tokenChainId,
    fund.tokenAddress,
    fund.tokenDecimals,
  );
  const hint =
    circ.source === "chain"
      ? t("kpi.circulationHintChain")
      : circ.source === "cards"
        ? t("kpi.circulationHintCards")
        : t("kpi.circulationHintNone");
  return (
    <KpiTile
      label={t("kpi.circulation")}
      value={circ.amount == null ? "—" : tokens(circ.amount)}
      hint={hint}
    />
  );
}

async function ActivityTiles() {
  const { t, fund, eur, count } = await getFormatters();
  const [members, merchants, money] = await Promise.all([
    getMemberKpis(fund.id),
    getMerchantKpis(fund.id),
    getMonthMoneyKpis(fund.id),
  ]);
  return (
    <>
      <KpiTile
        label={t("kpi.activeMembers")}
        value={count(members.active)}
        hint={t("kpi.activeMembersHint", { n: members.newThisMonth })}
      />
      <KpiTile
        label={t("kpi.activeMerchants")}
        value={count(merchants.active)}
        hint={t("kpi.activeMerchantsHint", { n: merchants.connected })}
      />
      <KpiTile
        label={t("kpi.contributions")}
        value={eur(money.contributions)}
        hint={t("kpi.contributionsHint", {
          deposits: money.deposits,
          unmatched: money.unmatched,
        })}
      />
    </>
  );
}

async function MonthFlowTiles() {
  const { t, fund, eur, tokens } = await getFormatters();
  const money = await getMonthMoneyKpis(fund.id);
  return (
    <>
      <KpiTile
        label={t("kpi.allocated")}
        value={tokens(money.allocated)}
        hint={t("kpi.allocatedHint")}
      />
      <KpiTile
        label={t("kpi.paidOut")}
        value={eur(money.paidOut)}
        hint={t("kpi.paidOutHint", { n: money.payoutTransfers })}
      />
    </>
  );
}

async function HoldingsTile() {
  const { t, fund, tokens } = await getFormatters();
  const held = await getMerchantHoldings(
    fund.id,
    fund.citizenPayApiKeyId,
    fund.citizenPayApiKeyEnc,
  );
  return (
    <KpiTile
      label={t("kpi.heldByMerchants")}
      value={held == null ? "—" : tokens(held)}
      hint={
        held == null
          ? t("kpi.heldByMerchantsUnavailable")
          : t("kpi.heldByMerchantsHint")
      }
    />
  );
}

async function PendingTile({ months }: { months: number }) {
  const { t, fund, count } = await getFormatters();
  const health = await getAllocationHealth(fund.id, months);
  return (
    <KpiTile
      label={t("kpi.pending")}
      value={count(health.pending)}
      hint={t("kpi.pendingHint", { failed: health.failed, months })}
      hintClassName={health.failed > 0 ? "text-destructive" : undefined}
    />
  );
}

function KpiTile({
  label,
  value,
  hint,
  hintClassName,
}: {
  label: string;
  value: string;
  hint: string;
  hintClassName?: string;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      <CardContent className="pb-3">
        <p className={cn("text-xs text-muted-foreground", hintClassName)}>
          {hint}
        </p>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

async function MoneyChart({ months }: { months: number }) {
  const { t, fund, symbol } = await getFormatters();
  const locale = await getLocale();
  const series = await getMoneySeries(fund.id, months);
  const data = await chartData(series);

  const eurFormat: ValueFormat = { style: "currency", currency: "EUR", locale };
  const tokenFormat: ValueFormat = { style: "decimal", locale, suffix: symbol };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("charts.moneyTitle")}</CardTitle>
        <CardDescription>
          {t("charts.moneyDescription", { symbol })}
        </CardDescription>
      </CardHeader>
      <CardContent className="pb-2">
        <BarChart
          data={data}
          series={[
            {
              name: t("charts.contributionsSeries"),
              color: SERIES_1,
              format: eurFormat,
            },
            {
              name: t("charts.allocatedSeries", { symbol }),
              color: SERIES_2,
              format: tokenFormat,
            },
          ]}
          // Axis in plain numbers: the two series share a scale because
          // 1 token = 1 € in this product.
          valueFormat={{ style: "decimal", locale }}
          ariaLabel={t("charts.moneyAria")}
          emptyLabel={t("charts.empty")}
        />
      </CardContent>
    </Card>
  );
}

async function MembersChart({ months }: { months: number }) {
  const { t, fund } = await getFormatters();
  const locale = await getLocale();
  const series = await getMemberSeries(fund.id, months);
  const data = await chartData(series);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("charts.membersTitle")}</CardTitle>
        <CardDescription>
          {t("charts.membersDescription", { total: series.total })}
        </CardDescription>
      </CardHeader>
      <CardContent className="pb-2">
        <BarChart
          data={data}
          series={[{ name: t("charts.membersSeries"), color: SERIES_1 }]}
          valueFormat={{ style: "decimal", locale }}
          ariaLabel={t("charts.membersAria")}
          emptyLabel={t("charts.empty")}
        />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Breakdown cards
// ---------------------------------------------------------------------------

async function MerchantPayoutsCard({ months }: { months: number }) {
  const { t, fund, eur } = await getFormatters();
  const payouts = await getMerchantPayouts(fund.id, months);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("payouts.title")}</CardTitle>
        <CardDescription>
          {t("payouts.description", {
            total: eur(payouts.total),
            n: payouts.merchantsPaid,
            months,
          })}
        </CardDescription>
      </CardHeader>
      <CardContent className="pb-4">
        <RankedBars
          rows={payouts.top.map((m) => ({
            label: m.name,
            value: m.amount,
            display: eur(m.amount),
          }))}
          emptyLabel={t("payouts.empty")}
        />
      </CardContent>
    </Card>
  );
}

async function MembersByStatusCard() {
  const { t, fund, eur, tokens } = await getFormatters();
  const [statuses, tiers] = await Promise.all([
    getMemberStatusCounts(fund.id),
    getAllocationTiers(fund.id),
  ]);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("members.title")}</CardTitle>
        <CardDescription>{t("members.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5 pb-4">
        <StatusBreakdown
          segments={statuses.map((s) => ({
            label: t(`memberStatus.${s.status}`),
            count: s.count,
          }))}
          ariaLabel={t("members.title")}
          emptyLabel={t("members.empty")}
        />

        <div className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground">
            {t("tiers.title")}
          </h3>
          {tiers.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("tiers.empty")}</p>
          ) : (
            <ul className="space-y-1.5">
              {tiers.map((tier) => (
                <li
                  key={tier.id}
                  className="flex items-center justify-between gap-3 rounded-md bg-muted/40 px-3 py-2"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium">
                      {tier.name}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {t("tiers.range", {
                        min: eur(tier.min),
                        max: eur(tier.max),
                      })}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-sm font-medium tabular-nums">
                      {tokens(tier.allocation)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {t("tiers.members", { n: tier.members })}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Recent activity + CitizenPay footer
// ---------------------------------------------------------------------------

async function RecentActivity() {
  const { t, format, fund, tokens } = await getFormatters();
  const ops = await getRecentOperations(fund.id);

  return (
    <section className="space-y-3">
      <h2 className="font-heading text-lg font-medium">
        {t("recentActivity.title")}
      </h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("recentActivity.date")}</TableHead>
            <TableHead>{t("recentActivity.event")}</TableHead>
            <TableHead>{t("recentActivity.subject")}</TableHead>
            <TableHead className="text-right">
              {t("recentActivity.amount")}
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ops.length === 0 ? (
            <TableEmpty colSpan={4}>{t("recentActivity.empty")}</TableEmpty>
          ) : (
            ops.map((op) => (
              <TableRow key={op.id}>
                <TableCell className="text-sm text-muted-foreground">
                  {format.dateTime(op.submittedAt, { dateStyle: "medium" })}
                </TableCell>
                <TableCell className="text-sm">
                  {t(`recentActivity.type.${op.type}`)}
                  <span
                    className={cn(
                      "text-muted-foreground",
                      op.status === "FAILED" && "text-destructive",
                    )}
                  >
                    {" · "}
                    {t(`recentActivity.status.${op.status}`)}
                  </span>
                </TableCell>
                <TableCell className="text-sm">
                  {op.memberName ? (
                    <Sensitive kind="name">{op.memberName}</Sensitive>
                  ) : (
                    "—"
                  )}
                </TableCell>
                <TableCell className="text-right font-medium tabular-nums">
                  {op.type === "BURN" ? "−" : ""}
                  {tokens(op.amount)}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </section>
  );
}

async function CitizenPayFooter() {
  const { t, format, fund } = await getFormatters();
  return (
    <p className="text-xs text-muted-foreground">
      {fund.citizenPayFundId
        ? t("citizenpay.connected", {
            account: fund.citizenPayFundId,
            lastSync: fund.citizenPayLastSyncedAt
              ? format.dateTime(fund.citizenPayLastSyncedAt, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })
              : t("citizenpay.never"),
          })
        : t("citizenpay.notConnected")}
    </p>
  );
}
