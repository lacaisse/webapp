// SPDX-License-Identifier: AGPL-3.0-or-later
import { Suspense } from "react";
import Link from "next/link";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";

import type { ValueFormat } from "@/components/charts/bar-chart";
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
import { requireFundRole } from "@/services/auth/dal";
import { mergeMonthly } from "@/services/statistics/aggregate";
import {
  getContributionStats,
  getLocalMerchantsForPlaces,
  getMerchantStats,
  getPaidOutStats,
} from "@/services/statistics/data";

import { DateRangeFilter } from "./date-range-filter";
import { MonthlyChart } from "./monthly-chart";
import { DEFAULT_RANGE, isRangePreset, resolveRangeWindow } from "./range";
import {
  ChartCardSkeleton,
  KpiTileSkeleton,
  MerchantsCardSkeleton,
} from "./skeleton";

// Fund statistics for the board: what members contributed, what they spent at
// merchants, how many sales that was, and what merchants were paid out, over
// a URL-driven date range (default: all time). Fund-wide money → ADMIN-only.
//
// Contributions and payouts are the fund's own bank rows with the dashboard's
// definitions (every INCOMING row in, every OUTGOING row out), so the two
// pages agree on any month they both show. Sales come from CitizenPay, so
// those sections degrade to "—" and a notice when CP is down instead of
// reading as zero.
//
// URL state: ?range=all|thisMonth|lastMonth|thisYear|lastYear|custom, plus
// ?from / ?to (YYYY-MM-DD, `to` inclusive) for custom.

// Same series colours as the dashboard's money chart.
const SERIES_1 = "var(--chart-1)";
const SERIES_2 = "var(--chart-4)";

// Long tail beyond this is summarised in one line: the board reads the top
// of the list, and a fund with hundreds of places shouldn't render them all.
const MERCHANT_ROWS = 25;

type Window = {
  fundId: string;
  keyId: string | null;
  keyEnc: string | null;
  fromIso: string | null;
  toIso: string | null;
};

export default async function StatisticsPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; from?: string; to?: string }>;
}) {
  const { fund } = await requireFundRole("ADMIN");
  const t = await getTranslations("fund.statistics");

  const sp = await searchParams;
  const range = isRangePreset(sp.range) ? sp.range : DEFAULT_RANGE;
  const from = sp.from ?? "";
  const to = sp.to ?? "";
  const span = resolveRangeWindow(range, from || undefined, to || undefined);

  const w: Window = {
    fundId: fund.id,
    keyId: fund.citizenPayApiKeyId,
    keyEnc: fund.citizenPayApiKeyEnc,
    fromIso: span.from?.toISOString() ?? null,
    toIso: span.to?.toISOString() ?? null,
  };
  // Re-show every skeleton when the range changes, not just on first load.
  const key = `${range}:${from}:${to}`;

  return (
    <>
      <header className="space-y-1">
        <h1 className="font-heading text-2xl font-medium">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </header>

      <DateRangeFilter range={range} from={from} to={to} />

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Suspense key={`c:${key}`} fallback={<KpiTileSkeleton />}>
          <ContributionTile w={w} />
        </Suspense>
        <Suspense key={`s:${key}`} fallback={<KpiTileSkeleton count={2} />}>
          <SalesTiles w={w} />
        </Suspense>
        <Suspense key={`p:${key}`} fallback={<KpiTileSkeleton />}>
          <PayoutTile w={w} />
        </Suspense>
      </section>

      <Suspense key={`m:${key}`} fallback={<ChartCardSkeleton />}>
        <MonthlyCard w={w} />
      </Suspense>

      <Suspense key={`b:${key}`} fallback={<MerchantsCardSkeleton />}>
        <MerchantsCard w={w} />
      </Suspense>
    </>
  );
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

async function getFormatters() {
  const [t, format] = await Promise.all([
    getTranslations("fund.statistics"),
    getFormatter(),
  ]);
  return {
    t,
    eur: (v: string) =>
      format.number(Number(v), { style: "currency", currency: "EUR" }),
    count: (n: number) => format.number(n),
  };
}

// ---------------------------------------------------------------------------
// KPI tiles
// ---------------------------------------------------------------------------

async function ContributionTile({ w }: { w: Window }) {
  const { t, eur } = await getFormatters();
  const c = await getContributionStats(w.fundId, w.fromIso, w.toIso);
  return (
    <KpiTile
      label={t("kpi.contributed")}
      value={eur(c.total)}
      hint={t("kpi.contributedHint", {
        deposits: c.count,
        unmatched: c.unmatchedCount,
      })}
    />
  );
}

async function SalesTiles({ w }: { w: Window }) {
  const { t, eur, count } = await getFormatters();
  const { stats, error } = await getMerchantStats(
    w.fundId,
    w.keyId,
    w.keyEnc,
    w.fromIso,
    w.toIso,
  );
  if (error || !stats) {
    return (
      <>
        <KpiTile label={t("kpi.spent")} value="—" hint={t("errors.citizenpay")} />
        <KpiTile
          label={t("kpi.transactions")}
          value="—"
          hint={t("errors.citizenpay")}
        />
      </>
    );
  }
  return (
    <>
      <KpiTile
        label={t("kpi.spent")}
        value={eur(stats.orders.total)}
        hint={t("kpi.spentHint", { net: eur(stats.orders.net) })}
      />
      <KpiTile
        label={t("kpi.transactions")}
        value={count(stats.orders.count)}
        hint={t("kpi.transactionsHint", { n: stats.orders.refundCount })}
      />
    </>
  );
}

async function PayoutTile({ w }: { w: Window }) {
  const { t, eur } = await getFormatters();
  const p = await getPaidOutStats(w.fundId, w.fromIso, w.toIso);
  return (
    <KpiTile
      label={t("kpi.paidOut")}
      value={eur(p.total)}
      hint={t("kpi.paidOutHint", { n: p.count })}
    />
  );
}

function KpiTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
      </CardHeader>
      <CardContent className="pb-3">
        <p className="text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Monthly chart
// ---------------------------------------------------------------------------

async function MonthlyCard({ w }: { w: Window }) {
  const { t, eur } = await getFormatters();
  const [format, locale, contributions, merchant] = await Promise.all([
    getFormatter(),
    getLocale(),
    getContributionStats(w.fundId, w.fromIso, w.toIso),
    getMerchantStats(w.fundId, w.keyId, w.keyEnc, w.fromIso, w.toIso),
  ]);
  const months = mergeMonthly(
    contributions.months,
    (merchant.stats?.months ?? []).map((m) => ({ month: m.month, total: m.total })),
    {
      from: w.fromIso ? new Date(w.fromIso) : null,
      to: w.toIso ? new Date(w.toIso) : null,
    },
  );

  // Built like the dashboard's chartData: labels pre-formatted here, on UTC
  // month starts. An axis that crosses a year boundary (all time, a custom
  // range) carries the year on its short labels too.
  const spansYears =
    months.length > 0 &&
    months[0].month.slice(0, 4) !== months[months.length - 1].month.slice(0, 4);
  const points = months.map((m) => {
    const [y, mo] = m.month.split("-").map(Number);
    const d = new Date(Date.UTC(y, mo - 1, 1));
    return {
      label: format.dateTime(d, {
        month: "short",
        ...(spansYears ? { year: "2-digit" as const } : {}),
        timeZone: "UTC",
      }),
      fullLabel: format.dateTime(d, {
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      }),
      values: [Number(m.contributions) || 0, Number(m.spent) || 0],
      contributions: eur(m.contributions),
      spent: eur(m.spent),
    };
  });
  const eurFormat: ValueFormat = { style: "currency", currency: "EUR", locale };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("chart.title")}</CardTitle>
        <CardDescription>{t("chart.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 pb-4">
        <MonthlyChart
          data={points.map((p) => ({
            label: p.label,
            fullLabel: p.fullLabel,
            values: p.values,
          }))}
          series={[
            { name: t("chart.contributionsSeries"), color: SERIES_1 },
            { name: t("chart.spentSeries"), color: SERIES_2 },
          ]}
          valueFormat={eurFormat}
          ariaLabel={t("chart.aria")}
          emptyLabel={t("chart.empty")}
          rows={points.map((p) => ({
            month: p.fullLabel,
            contributions: p.contributions,
            spent: p.spent,
          }))}
          labels={{
            month: t("chart.month"),
            showTable: t("chart.showTable"),
            showChart: t("chart.showChart"),
          }}
        />
        {merchant.error && (
          <p className="text-xs text-muted-foreground">{t("errors.citizenpay")}</p>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Per-merchant breakdown
// ---------------------------------------------------------------------------

async function MerchantsCard({ w }: { w: Window }) {
  const { t, eur, count } = await getFormatters();
  const { stats, error } = await getMerchantStats(
    w.fundId,
    w.keyId,
    w.keyEnc,
    w.fromIso,
    w.toIso,
  );
  const places = [...(stats?.places ?? [])].sort(
    (a, b) => Number(b.total) - Number(a.total),
  );
  const shown = places.slice(0, MERCHANT_ROWS);
  const hidden = places.length - shown.length;

  const local = await getLocalMerchantsForPlaces(
    w.fundId,
    shown.map((p) => p.placeId),
  );
  const localByPlace = new Map(local.map((m) => [m.citizenPayPlaceId, m]));

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("merchants.title")}</CardTitle>
        <CardDescription>{t("merchants.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2 pb-4">
        {error ? (
          <p className="text-sm text-muted-foreground">{t("errors.citizenpay")}</p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("merchants.columns.name")}</TableHead>
                  <TableHead className="text-right">
                    {t("merchants.columns.transactions")}
                  </TableHead>
                  <TableHead className="text-right">
                    {t("merchants.columns.refunds")}
                  </TableHead>
                  <TableHead className="text-right">
                    {t("merchants.columns.amount")}
                  </TableHead>
                  <TableHead className="text-right">
                    {t("merchants.columns.net")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.length === 0 ? (
                  <TableEmpty colSpan={5}>{t("merchants.empty")}</TableEmpty>
                ) : (
                  shown.map((p) => {
                    // Our own merchant row (and its name, which admins may
                    // have edited) when the place is enrolled in this fund;
                    // otherwise CitizenPay's place name, unlinked.
                    const merchant = localByPlace.get(p.placeId);
                    return (
                      <TableRow key={p.placeId}>
                        <TableCell className="text-sm font-medium">
                          {merchant ? (
                            <Link
                              href={`/merchants/${merchant.id}`}
                              className="underline-offset-4 hover:underline"
                            >
                              {merchant.name}
                            </Link>
                          ) : (
                            p.placeName
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {count(p.count)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums text-muted-foreground">
                          {count(p.refundCount)}
                        </TableCell>
                        <TableCell className="text-right font-medium tabular-nums">
                          {eur(p.total)}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {eur(p.net)}
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
            {hidden > 0 && (
              <p className="text-xs text-muted-foreground">
                {t("merchants.more", { n: hidden })}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
