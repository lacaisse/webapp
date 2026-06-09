// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { requireCurrentFund } from "@/services/fund/server";
import { PeriodDialog } from "./period-dialog";
import { ArchiveTierButton, TierDialog } from "./tier-dialog";

const TABS = [
  { value: "history" },
  { value: "tiers" },
  { value: "schedule" },
] as const;

export default async function AllocationsPage({
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
      <header className="space-y-1">
        <h1 className="font-heading text-2xl font-medium">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </header>

      <Tabs
        active={active}
        items={TABS.map((tab) => ({
          value: tab.value,
          label: t(`tabs.${tab.value}`),
        }))}
      />

      {active === "history" && <HistoryTab fundId={fund.id} />}
      {active === "tiers" && <TiersTab fundId={fund.id} />}
      {active === "schedule" && (
        <ScheduleTab
          fundId={fund.id}
          allocationMode={fund.allocationMode}
        />
      )}
    </>
  );
}

async function HistoryTab({ fundId }: { fundId: string }) {
  const t = await getTranslations("fund.allocations.history");
  const format = await getFormatter();

  const ops = await prisma.tokenOperation.findMany({
    where: { fundId, type: "MINT" },
    orderBy: { submittedAt: "desc" },
    take: 200,
    include: {
      member: { select: { firstName: true, lastName: true } },
      tier: { select: { name: true } },
      allocationPeriod: { select: { label: true } },
      referral: { select: { id: true } },
      sources: { select: { id: true }, take: 1 },
    },
  });

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("date")}</TableHead>
          <TableHead>{t("member")}</TableHead>
          <TableHead>{t("tier")}</TableHead>
          <TableHead>{t("source")}</TableHead>
          <TableHead>{t("period")}</TableHead>
          <TableHead className="text-right">{t("amount")}</TableHead>
          <TableHead>{t("status")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {ops.length === 0 ? (
          <TableEmpty colSpan={7}>{t("empty")}</TableEmpty>
        ) : (
          ops.map((op) => {
            const memberName = op.member
              ? `${op.member.firstName} ${op.member.lastName}`.trim()
              : "—";
            const source = op.referral
              ? t("sources.referral")
              : op.sources.length > 0
                ? t("sources.bankSync")
                : t("sources.manual");
            return (
              <TableRow key={op.id}>
                <TableCell className="text-sm text-muted-foreground">
                  {format.dateTime(op.submittedAt, { dateStyle: "medium" })}
                </TableCell>
                <TableCell>{memberName}</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {op.tier?.name ?? "—"}
                </TableCell>
                <TableCell className="text-sm">{source}</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {op.allocationPeriod?.label ?? "—"}
                </TableCell>
                <TableCell className="text-right font-medium">
                  {op.amount.toString()}
                </TableCell>
                <TableCell>
                  <OperationStatusBadge status={op.status} />
                </TableCell>
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
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
  allocationMode: "FIXED_PERIOD" | "PAY_AND_GO";
}) {
  const t = await getTranslations("fund.allocations.schedule");
  const format = await getFormatter();

  if (allocationMode === "PAY_AND_GO") {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("payAndGoDescription")}</CardDescription>
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
                        initialCutoff: p.cutoffDate
                          .toISOString()
                          .slice(0, 10),
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

function OperationStatusBadge({
  status,
}: {
  status: "PENDING" | "CONFIRMED" | "FAILED";
}) {
  if (status === "CONFIRMED") return <Badge variant="success">{status}</Badge>;
  if (status === "FAILED") return <Badge variant="destructive">{status}</Badge>;
  return <Badge variant="warning">{status}</Badge>;
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
