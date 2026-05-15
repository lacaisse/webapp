import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";

import { Badge } from "@/components/ui/badge";
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

export default async function AllocationPeriodDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const t = await getTranslations("fund.allocations.periodDetail");
  const format = await getFormatter();
  const fund = await requireCurrentFund();
  const { id } = await params;

  const period = await prisma.allocationPeriod.findFirst({
    where: { id, fundId: fund.id },
    include: {
      bankTransactions: {
        orderBy: { occurredAt: "desc" },
        include: {
          member: { select: { id: true, firstName: true, lastName: true } },
        },
      },
      tokenOperations: {
        orderBy: { submittedAt: "desc" },
        include: {
          member: { select: { id: true, firstName: true, lastName: true } },
          tier: { select: { name: true } },
        },
      },
    },
  });

  if (!period) notFound();

  const depositsTotal = period.bankTransactions.reduce(
    (acc, b) => acc + Number(b.amount),
    0,
  );
  const mintedTotal = period.tokenOperations
    .filter((op) => op.type === "MINT" && op.status === "CONFIRMED")
    .reduce((acc, op) => acc + Number(op.amount), 0);
  const distinctMembers = new Set(
    period.bankTransactions
      .map((b) => b.memberId)
      .filter((id): id is string => id !== null),
  ).size;

  return (
    <>
      <Link
        href="/allocations?tab=schedule"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        {t("back")}
      </Link>

      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-heading text-2xl font-medium">{period.label}</h1>
          <PeriodStatusBadge status={period.status} />
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground">
          <span>
            {t("range", {
              starts: format.dateTime(period.startsAt, { dateStyle: "medium" }),
              cutoff: format.dateTime(period.cutoffDate, {
                dateStyle: "medium",
              }),
            })}
          </span>
          {period.closedAt && (
            <span>
              {t("closedAt", {
                date: format.dateTime(period.closedAt, {
                  dateStyle: "medium",
                  timeStyle: "short",
                }),
              })}
            </span>
          )}
        </div>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label={t("kpi.deposits")}
          value={depositsTotal.toFixed(2)}
          hint={t("kpi.depositsHint", {
            count: period.bankTransactions.length,
          })}
        />
        <KpiCard
          label={t("kpi.minted")}
          value={mintedTotal.toFixed(2)}
          hint={t("kpi.mintedHint", {
            count: period.tokenOperations.length,
          })}
        />
        <KpiCard
          label={t("kpi.members")}
          value={distinctMembers.toString()}
          hint={t("kpi.membersHint")}
        />
        <KpiCard
          label={t("kpi.status")}
          value={period.status}
          hint={t(`kpi.statusHints.${period.status}`)}
        />
      </section>

      {period.notes && (
        <Card size="sm">
          <CardHeader>
            <CardTitle>{t("notes")}</CardTitle>
          </CardHeader>
          <CardContent className="pb-3 text-sm">
            <p className="whitespace-pre-wrap">{period.notes}</p>
          </CardContent>
        </Card>
      )}

      <section className="space-y-3">
        <h2 className="font-heading text-lg font-medium">
          {t("deposits.title")}
        </h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("deposits.date")}</TableHead>
              <TableHead>{t("deposits.member")}</TableHead>
              <TableHead>{t("deposits.reference")}</TableHead>
              <TableHead className="text-right">
                {t("deposits.amount")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {period.bankTransactions.length === 0 ? (
              <TableEmpty colSpan={4}>{t("deposits.empty")}</TableEmpty>
            ) : (
              period.bankTransactions.map((b) => (
                <TableRow key={b.id}>
                  <TableCell className="text-sm text-muted-foreground">
                    {format.dateTime(b.occurredAt, { dateStyle: "medium" })}
                  </TableCell>
                  <TableCell>
                    {b.member ? (
                      <Link
                        href={`/members/${b.member.id}`}
                        className="hover:underline"
                      >
                        {`${b.member.firstName} ${b.member.lastName}`.trim()}
                      </Link>
                    ) : (
                      <span className="text-sm text-muted-foreground">
                        {b.counterpartName ?? "—"}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {b.counterpartReference ?? b.remittanceInfo ?? "—"}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {b.amount.toString()} {b.currency}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </section>

      <section className="space-y-3">
        <h2 className="font-heading text-lg font-medium">
          {t("mints.title")}
        </h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("mints.date")}</TableHead>
              <TableHead>{t("mints.member")}</TableHead>
              <TableHead>{t("mints.tier")}</TableHead>
              <TableHead className="text-right">{t("mints.amount")}</TableHead>
              <TableHead>{t("mints.status")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {period.tokenOperations.length === 0 ? (
              <TableEmpty colSpan={5}>{t("mints.empty")}</TableEmpty>
            ) : (
              period.tokenOperations.map((op) => (
                <TableRow key={op.id}>
                  <TableCell className="text-sm text-muted-foreground">
                    {format.dateTime(op.submittedAt, { dateStyle: "medium" })}
                  </TableCell>
                  <TableCell>
                    {op.member ? (
                      <Link
                        href={`/members/${op.member.id}`}
                        className="hover:underline"
                      >
                        {`${op.member.firstName} ${op.member.lastName}`.trim()}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {op.tier?.name ?? "—"}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {op.amount.toString()}
                  </TableCell>
                  <TableCell>
                    <OperationStatusBadge status={op.status} />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </section>
    </>
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

function OperationStatusBadge({
  status,
}: {
  status: "PENDING" | "CONFIRMED" | "FAILED";
}) {
  if (status === "CONFIRMED") return <Badge variant="success">{status}</Badge>;
  if (status === "FAILED") return <Badge variant="destructive">{status}</Badge>;
  return <Badge variant="warning">{status}</Badge>;
}
