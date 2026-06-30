// SPDX-License-Identifier: AGPL-3.0-or-later
import { Suspense } from "react";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { TableSkeleton } from "@/components/table-skeleton";
import { Tabs, resolveActiveTab } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { prisma } from "@/services/db/prisma";
import { requireFundRole } from "@/services/auth/dal";
import { requireCurrentFund } from "@/services/fund/server";
import { PeriodDialog } from "./period-dialog";
import { ArchiveTierButton, TierDialog } from "./tier-dialog";

const TABS = [{ value: "schedule" }, { value: "tiers" }] as const;

// Synchronous shell: header + tab bar stream quickly; the active tab's data
// table streams behind its own (keyed) <Suspense> so switching tabs re-shows
// the skeleton instead of blocking.
export default async function AllocationsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  await requireFundRole("ADMIN");
  return (
    <>
      <Suspense fallback={<AllocationsHeaderSkeleton />}>
        <AllocationsHeader />
      </Suspense>
      <Suspense fallback={<AllocationsTabsSkeleton />}>
        <AllocationsTabs searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function AllocationsHeader() {
  const t = await getTranslations("fund.allocations");
  return (
    <header className="space-y-1">
      <h1 className="font-heading text-2xl font-medium">{t("title")}</h1>
      <p className="text-sm text-muted-foreground">{t("description")}</p>
    </header>
  );
}

async function AllocationsTabs({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const t = await getTranslations("fund.allocations");
  const fund = await requireCurrentFund();
  const sp = await searchParams;
  const active = resolveActiveTab(sp.tab, TABS);

  return (
    <>
      <Tabs
        active={active}
        items={TABS.map((tab) => ({
          value: tab.value,
          label: t(`tabs.${tab.value}`),
        }))}
      />

      <Suspense key={active} fallback={<TableSkeleton columns={6} />}>
        {active === "schedule" && (
          <ScheduleTab fundId={fund.id} allocationMode={fund.allocationMode} />
        )}
        {active === "tiers" && <TiersTab fundId={fund.id} />}
      </Suspense>
    </>
  );
}

function AllocationsHeaderSkeleton() {
  return (
    <div className="space-y-1">
      <Skeleton className="h-7 w-40" />
      <Skeleton className="h-4 w-80 max-w-full" />
    </div>
  );
}

function AllocationsTabsSkeleton() {
  return (
    <>
      <div className="flex gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-24" />
        ))}
      </div>
      <TableSkeleton columns={6} />
    </>
  );
}

async function TiersTab({ fundId }: { fundId: string }) {
  const t = await getTranslations("fund.allocations.tiers");
  const tiers = await prisma.allocationTier.findMany({
    where: { fundId, archivedAt: null },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    include: { _count: { select: { members: true } } },
  });
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end">
        <TierDialog
          mode={{ kind: "create" }}
          trigger={<Button variant="default">{t("addTier")}</Button>}
        />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("name")}</TableHead>
            <TableHead className="text-right">{t("min")}</TableHead>
            <TableHead className="text-right">{t("target")}</TableHead>
            <TableHead className="text-right">{t("max")}</TableHead>
            <TableHead className="text-right">{t("members")}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {tiers.length === 0 ? (
            <TableEmpty colSpan={6}>{t("empty")}</TableEmpty>
          ) : (
            tiers.map((tier) => (
              <TableRow key={tier.id}>
                <TableCell className="font-medium">{tier.name}</TableCell>
                <TableCell className="text-right text-sm text-muted-foreground">
                  {tier.minContribution.toString()}
                </TableCell>
                <TableCell className="text-right font-medium">
                  {tier.allocationAmount.toString()}
                </TableCell>
                <TableCell className="text-right text-sm text-muted-foreground">
                  {tier.maxContribution.toString()}
                </TableCell>
                <TableCell className="text-right">
                  {tier._count.members}
                </TableCell>
                <TableCell className="text-right">
                  <div className="inline-flex items-center gap-1">
                    <TierDialog
                      mode={{
                        kind: "edit",
                        tierId: tier.id,
                        initial: {
                          name: tier.name,
                          minContribution: tier.minContribution.toString(),
                          allocationAmount: tier.allocationAmount.toString(),
                          maxContribution: tier.maxContribution.toString(),
                          position: tier.position,
                        },
                      }}
                      trigger={
                        <Button variant="ghost" size="sm">
                          {t("edit")}
                        </Button>
                      }
                    />
                    {tier._count.members === 0 && (
                      <ArchiveTierButton tierId={tier.id} />
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

async function ScheduleTab({
  fundId,
  allocationMode,
}: {
  fundId: string;
  allocationMode: "FIXED_PERIOD" | "PAY_AND_GO" | "DISABLED";
}) {
  const t = await getTranslations("fund.allocations.schedule");
  const format = await getFormatter();

  // Only FIXED_PERIOD funds have periods. Pay-and-go and disabled funds show
  // an explanatory card instead of the period schedule.
  if (allocationMode !== "FIXED_PERIOD") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>
            {allocationMode === "PAY_AND_GO"
              ? t("payAndGoDescription")
              : t("disabledDescription")}
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  const periods = await prisma.allocationPeriod.findMany({
    where: { fundId },
    orderBy: { cutoffDate: "desc" },
    take: 10,
  });

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <PeriodDialog
          mode={{ kind: "create" }}
          trigger={<Button size="sm">{t("newPeriod")}</Button>}
        />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("label")}</TableHead>
            <TableHead>{t("startsAt")}</TableHead>
            <TableHead>{t("cutoffDate")}</TableHead>
            <TableHead>{t("status")}</TableHead>
            <TableHead>{t("closedAt")}</TableHead>
            <TableHead className="text-right">{t("actions")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {periods.length === 0 ? (
            <TableEmpty colSpan={6}>{t("empty")}</TableEmpty>
          ) : (
            periods.map((p) => (
              <TableRow key={p.id}>
                <TableCell className="font-medium">
                  <Link
                    href={`/allocations/periods/${p.id}`}
                    className="hover:underline"
                  >
                    {p.label}
                  </Link>
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {format.dateTime(p.startsAt, { dateStyle: "medium" })}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {format.dateTime(p.cutoffDate, { dateStyle: "medium" })}
                </TableCell>
                <TableCell>
                  <PeriodStatusBadge status={p.status} />
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {p.closedAt
                    ? format.dateTime(p.closedAt, { dateStyle: "medium" })
                    : "—"}
                </TableCell>
                <TableCell className="text-right">
                  {p.status === "CLOSED" ? (
                    "—"
                  ) : (
                    <PeriodDialog
                      mode={{
                        kind: "edit",
                        periodId: p.id,
                        initialCutoff: p.cutoffDate.toISOString().slice(0, 10),
                      }}
                      trigger={
                        <Button variant="ghost" size="sm">
                          {t("edit")}
                        </Button>
                      }
                    />
                  )}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function PeriodStatusBadge({
  status,
}: {
  status: "OPEN" | "IN_PROGRESS" | "CLOSED";
}) {
  if (status === "OPEN") return <Badge variant="success">{status}</Badge>;
  if (status === "IN_PROGRESS")
    return <Badge variant="warning">{status}</Badge>;
  return <Badge>{status}</Badge>;
}
