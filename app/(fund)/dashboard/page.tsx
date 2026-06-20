// SPDX-License-Identifier: AGPL-3.0-or-later
import { Suspense } from "react";
import { getFormatter, getTranslations } from "next-intl/server";

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
import { prisma } from "@/services/db/prisma";
import { requireCurrentFund } from "@/services/fund/server";

import {
  ActivitySkeleton,
  DashboardHeaderSkeleton,
  KpiSkeleton,
  TiersCitizenPaySkeleton,
} from "./skeleton";

// Synchronous shell: each section streams in behind its own <Suspense>, so the
// page paints its skeleton instantly and fills as each query resolves.
export default function FundDashboardPage() {
  return (
    <>
      <Suspense fallback={<DashboardHeaderSkeleton />}>
        <DashboardHeader />
      </Suspense>
      <Suspense fallback={<KpiSkeleton />}>
        <KpiSection />
      </Suspense>
      <Suspense fallback={<TiersCitizenPaySkeleton />}>
        <TiersAndCitizenPay />
      </Suspense>
      <Suspense fallback={<ActivitySkeleton />}>
        <RecentActivity />
      </Suspense>
    </>
  );
}

async function DashboardHeader() {
  const t = await getTranslations("fund.dashboard");
  return (
    <header className="space-y-1">
      <h1 className="font-heading text-2xl font-medium">{t("title")}</h1>
      <p className="text-sm text-muted-foreground">{t("description")}</p>
    </header>
  );
}

async function KpiSection() {
  const t = await getTranslations("fund.dashboard");
  const fund = await requireCurrentFund();

  const now = new Date();
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  );

  // KPIs derived from confirmed mints. "Spent this month" stays a TBD —
  // payments live entirely in CitizenPay and aren't mirrored locally.
  const [totalMinted, monthMinted, activeMembers] = await Promise.all([
    prisma.tokenOperation.aggregate({
      where: { fundId: fund.id, type: "MINT", status: "CONFIRMED" },
      _sum: { amount: true },
    }),
    prisma.tokenOperation.aggregate({
      where: {
        fundId: fund.id,
        type: "MINT",
        status: "CONFIRMED",
        confirmedAt: { gte: monthStart },
      },
      _sum: { amount: true },
    }),
    prisma.member.count({
      where: { fundId: fund.id, status: "ACTIVE" },
    }),
  ]);

  return (
    <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <KpiCard
        label={t("kpi.totalBalance")}
        value={totalMinted._sum.amount?.toString() ?? "0"}
        hint={t("kpi.totalBalanceHint")}
      />
      <KpiCard
        label={t("kpi.activeMembers")}
        value={activeMembers.toString()}
        hint={t("kpi.activeMembersHint")}
      />
      <KpiCard
        label={t("kpi.allocatedThisMonth")}
        value={monthMinted._sum.amount?.toString() ?? "0"}
        hint={t("kpi.allocatedThisMonthHint")}
      />
      <KpiCard
        label={t("kpi.spentThisMonth")}
        value="—"
        hint={t("kpi.spentThisMonthHint")}
      />
    </section>
  );
}

async function TiersAndCitizenPay() {
  const t = await getTranslations("fund.dashboard");
  const format = await getFormatter();
  const fund = await requireCurrentFund();

  const tiers = await prisma.allocationTier.findMany({
    where: { fundId: fund.id, archivedAt: null },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    include: { _count: { select: { members: true } } },
  });

  return (
    <section className="grid gap-3 lg:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle>{t("tiers.title")}</CardTitle>
          <CardDescription>{t("tiers.description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 pb-4">
          {tiers.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("tiers.empty")}</p>
          ) : (
            tiers.map((tier) => (
              <div
                key={tier.id}
                className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-2"
              >
                <div>
                  <div className="text-sm font-medium">{tier.name}</div>
                  <div className="text-xs text-muted-foreground">
                    {t("tiers.range", {
                      min: tier.minContribution.toString(),
                      max: tier.maxContribution.toString(),
                    })}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-medium">
                    {tier.allocationAmount.toString()}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {t("tiers.members", { n: tier._count.members })}
                  </div>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("citizenpay.title")}</CardTitle>
          <CardDescription>{t("citizenpay.description")}</CardDescription>
        </CardHeader>
        <CardContent className="pb-4">
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-muted-foreground">{t("citizenpay.account")}</dt>
            <dd>{fund.citizenPayFundId ?? "—"}</dd>
            <dt className="text-muted-foreground">{t("citizenpay.lastSync")}</dt>
            <dd>
              {fund.citizenPayLastSyncedAt
                ? format.dateTime(fund.citizenPayLastSyncedAt, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })
                : "—"}
            </dd>
          </dl>
        </CardContent>
      </Card>
    </section>
  );
}

async function RecentActivity() {
  const t = await getTranslations("fund.dashboard");
  const format = await getFormatter();
  const fund = await requireCurrentFund();

  const recentOps = await prisma.tokenOperation.findMany({
    where: { fundId: fund.id },
    orderBy: { submittedAt: "desc" },
    take: 10,
    include: {
      member: { select: { firstName: true, lastName: true } },
    },
  });

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
          {recentOps.length === 0 ? (
            <TableEmpty colSpan={4}>{t("recentActivity.empty")}</TableEmpty>
          ) : (
            recentOps.map((op) => {
              const memberName = op.member
                ? `${op.member.firstName} ${op.member.lastName}`.trim()
                : "—";
              return (
                <TableRow key={op.id}>
                  <TableCell className="text-sm text-muted-foreground">
                    {format.dateTime(op.submittedAt, { dateStyle: "medium" })}
                  </TableCell>
                  <TableCell className="text-sm">
                    {op.type} · {op.status}
                  </TableCell>
                  <TableCell className="text-sm">{memberName}</TableCell>
                  <TableCell className="text-right font-medium">
                    {op.amount.toString()}
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </section>
  );
}

function KpiCard({
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
        <CardTitle className="text-2xl">{value}</CardTitle>
      </CardHeader>
      <CardContent className="pb-3">
        <p className="text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}
