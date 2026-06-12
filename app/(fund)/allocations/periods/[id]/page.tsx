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
import { AttributeDialog } from "@/app/(fund)/allocations/bank-transaction-actions";
import { findAllocationPlans } from "@/services/allocation-periods/run";
import { Prisma } from "@/services/db/generated/client";
import { prisma } from "@/services/db/prisma";
import { requireCurrentFund } from "@/services/fund/server";

import { AllocateMemberButton } from "./allocate-member-button";
import { RemoveDepositButton } from "./remove-deposit-button";
import { RunAllocation } from "./run-allocation";

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
          // Linked mint ops drive the per-deposit allocation badge. A deposit
          // that already fed a mint is also locked into the period — the
          // remove button is hidden for those.
          operationSources: {
            select: { tokenOperation: { select: { status: true } } },
          },
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

  // Members the period was expected to allocate to: ACTIVE, with a tier and a
  // primary card — the exact set the close process mints for (see
  // services/allocation-periods/close.ts). Pull each one's matched INCOMING
  // deposits in this period so we can split them into:
  //   - missing:  no deposit at all (the "supposed to pay but didn't" list)
  //   - belowMin: deposited, but total under the tier minimum → no mint
  // (above-maximum totals still allocate — only below-minimum is a problem)
  const expectedMembers = await prisma.member.findMany({
    where: {
      fundId: fund.id,
      status: "ACTIVE",
      tierId: { not: null },
      primaryCardId: { not: null },
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      tier: {
        select: { name: true, minContribution: true },
      },
      bankTransactions: {
        where: { allocationPeriodId: period.id, direction: "INCOMING" },
        select: { amount: true },
      },
    },
    orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
  });

  type ExpectedRow = {
    id: string;
    name: string;
    tierName: string;
    min: string;
    deposited: string;
  };
  const missing: ExpectedRow[] = [];
  const belowMin: ExpectedRow[] = [];
  for (const m of expectedMembers) {
    if (!m.tier) continue; // tierId not null guarantees this, but narrow the type
    const total = m.bankTransactions.reduce(
      (sum, b) => sum.add(b.amount),
      new Prisma.Decimal(0),
    );
    const row: ExpectedRow = {
      id: m.id,
      name: `${m.firstName} ${m.lastName}`.trim(),
      tierName: m.tier.name,
      min: m.tier.minContribution.toString(),
      deposited: total.toString(),
    };
    if (m.bankTransactions.length === 0) {
      missing.push(row);
    } else if (total.lt(m.tier.minContribution)) {
      belowMin.push(row);
    }
    // else: reached the minimum — allocated, not listed here.
  }

  // Members ready to allocate right now: qualifying deposit total, no mint for
  // this period yet. Same logic as the close cron and the run actions (see
  // services/allocation-periods/run.ts), so this lists exactly what a run
  // would mint — including late payers attributed after the period closed.
  const { plans: ready } = await findAllocationPlans({
    fundId: fund.id,
    periodId: period.id,
  });
  const readyTotal = ready
    .reduce((sum, p) => sum.add(p.amount), new Prisma.Decimal(0))
    .toString();

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
        <div className="space-y-1">
          <h2 className="font-heading text-lg font-medium">
            {t("ready.title", { count: ready.length })}
          </h2>
          <p className="text-sm text-muted-foreground">{t("ready.hint")}</p>
        </div>
        <RunAllocation
          periodId={period.id}
          readyCount={ready.length}
          totalAmount={readyTotal}
        />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("ready.member")}</TableHead>
              <TableHead>{t("ready.tier")}</TableHead>
              <TableHead className="text-right">
                {t("ready.deposited")}
              </TableHead>
              <TableHead className="text-right">
                {t("ready.allocation")}
              </TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {ready.length === 0 ? (
              <TableEmpty colSpan={5}>{t("ready.empty")}</TableEmpty>
            ) : (
              ready.map((p) => (
                <TableRow key={p.memberId}>
                  <TableCell>
                    <Link
                      href={`/members/${p.memberId}`}
                      className="hover:underline"
                    >
                      {p.memberName}
                    </Link>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {p.tierName}
                  </TableCell>
                  <TableCell className="text-right text-sm text-muted-foreground">
                    {p.deposited.toString()}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {p.amount.toString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <AllocateMemberButton
                      periodId={period.id}
                      memberId={p.memberId}
                      memberName={p.memberName}
                      amount={p.amount.toString()}
                      periodLabel={period.label}
                    />
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </section>

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
              <TableHead>{t("deposits.allocation")}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {period.bankTransactions.length === 0 ? (
              <TableEmpty colSpan={6}>{t("deposits.empty")}</TableEmpty>
            ) : (
              period.bankTransactions.map((b) => {
                const allocation = depositAllocation(
                  b.operationSources.map((s) => s.tokenOperation.status),
                );
                return (
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
                        <div className="flex items-center gap-2">
                          <span className="text-sm text-muted-foreground">
                            {b.counterpartName ?? "—"}
                          </span>
                          <AttributeDialog bankTransactionId={b.id} />
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {b.counterpartReference ?? b.remittanceInfo ?? "—"}
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      {b.amount.toString()} {b.currency}
                    </TableCell>
                    <TableCell>
                      <Badge variant={allocation.variant}>
                        {t(`deposits.${allocation.key}`)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {b.operationSources.length === 0 && (
                        <RemoveDepositButton
                          bankTransactionId={b.id}
                          label={
                            b.member
                              ? `${b.member.firstName} ${b.member.lastName}`.trim()
                              : (b.counterpartName ??
                                b.counterpartReference ??
                                "—")
                          }
                        />
                      )}
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </section>

      <section className="space-y-3">
        <h2 className="font-heading text-lg font-medium">{t("mints.title")}</h2>
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

      <section className="space-y-3">
        <div className="space-y-1">
          <h2 className="font-heading text-lg font-medium">
            {t("missing.title", { count: missing.length })}
          </h2>
          <p className="text-sm text-muted-foreground">{t("missing.hint")}</p>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("missing.member")}</TableHead>
              <TableHead>{t("missing.tier")}</TableHead>
              <TableHead className="text-right">
                {t("missing.minimum")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {missing.length === 0 ? (
              <TableEmpty colSpan={3}>{t("missing.empty")}</TableEmpty>
            ) : (
              missing.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>
                    <Link href={`/members/${m.id}`} className="hover:underline">
                      {m.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {m.tierName}
                  </TableCell>
                  <TableCell className="text-right text-sm text-muted-foreground">
                    {m.min}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </section>

      {belowMin.length > 0 && (
        <section className="space-y-3">
          <div className="space-y-1">
            <h2 className="font-heading text-lg font-medium">
              {t("belowMin.title", { count: belowMin.length })}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t("belowMin.hint")}
            </p>
          </div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("belowMin.member")}</TableHead>
                <TableHead>{t("belowMin.tier")}</TableHead>
                <TableHead className="text-right">
                  {t("belowMin.deposited")}
                </TableHead>
                <TableHead className="text-right">
                  {t("belowMin.minimum")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {belowMin.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>
                    <Link href={`/members/${m.id}`} className="hover:underline">
                      {m.name}
                    </Link>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {m.tierName}
                  </TableCell>
                  <TableCell className="text-right font-medium">
                    {m.deposited}
                  </TableCell>
                  <TableCell className="text-right text-sm text-muted-foreground">
                    {m.min}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}
    </>
  );
}

// Per-deposit allocation state, derived from the mint ops the deposit fed
// (M:N via TokenOperationSource). A deposit counts as allocated as soon as
// one linked mint isn't FAILED; only-FAILED links surface as failed so the
// admin knows a retry is needed.
function depositAllocation(
  statuses: Array<"PENDING" | "CONFIRMED" | "FAILED">,
): {
  variant: "success" | "warning" | "destructive" | "outline";
  key: "allocated" | "allocationPending" | "allocationFailed" | "notAllocated";
} {
  if (statuses.includes("CONFIRMED"))
    return { variant: "success", key: "allocated" };
  if (statuses.includes("PENDING"))
    return { variant: "warning", key: "allocationPending" };
  if (statuses.length > 0)
    return { variant: "destructive", key: "allocationFailed" };
  return { variant: "outline", key: "notAllocated" };
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
