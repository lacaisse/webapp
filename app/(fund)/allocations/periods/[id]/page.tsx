import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";

import { TableSkeleton } from "@/components/table-skeleton";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, resolveActiveTab } from "@/components/ui/tabs";
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
import { AttachAllocationDialog } from "./attach-allocation-dialog";
import { NotifyAllButton } from "./notify-all-button";
import { NotifyAllocationButton } from "./notify-allocation-button";
import { RemindMemberButton } from "./remind-member-button";
import { RemindUnpaidButton } from "./remind-unpaid-button";
import { RemoveDepositButton } from "./remove-deposit-button";
import { RunAllocation } from "./run-allocation";

// Synchronous shell so the route paints its skeleton instantly; the period
// (params-dependent, uncached) streams in behind <Suspense>.
export default function AllocationPeriodDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  return (
    <Suspense fallback={<AllocationPeriodDetailSkeleton />}>
      <AllocationPeriodDetail params={params} searchParams={searchParams} />
    </Suspense>
  );
}

// Per-section tabs. The period detail used to stack five tables vertically;
// they now live behind a tab bar so the page is scannable. `tab` lives in the
// URL so back/forward and shared links land on the right section.
const TABS = [
  { value: "ready" },
  { value: "deposits" },
  { value: "mints" },
  { value: "missing" },
  { value: "belowMin" },
] as const;

async function AllocationPeriodDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const t = await getTranslations("fund.allocations.periodDetail");
  const format = await getFormatter();
  const fund = await requireCurrentFund();
  const { id } = await params;
  const { tab } = await searchParams;
  const active = resolveActiveTab(tab, TABS);

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
          member: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
          tier: { select: { name: true } },
          // Allocation-confirmation emails for this mint drive the per-mint
          // notification badge + send/retry button.
          emails: {
            where: { type: "ALLOCATION_CONFIRMATION" },
            select: { status: true },
          },
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
      email: true,
      emailUnsubscribed: true,
      tier: {
        select: { name: true, minContribution: true },
      },
      bankTransactions: {
        where: { allocationPeriodId: period.id, direction: "INCOMING" },
        select: { amount: true },
      },
      // Payment reminders already sent for this period drive the per-member
      // reminder badge + send/retry button on the Missing tab (FIRST = the
      // monthly cron's automatic request, SECOND = a manual nudge).
      emails: {
        where: {
          allocationPeriodId: period.id,
          type: { in: ["PAYMENT_REMINDER_FIRST", "PAYMENT_REMINDER_SECOND"] },
        },
        select: { status: true },
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
  // Missing rows additionally carry whether the member can still be reminded
  // and their current reminder state, so the Missing tab can show a badge and a
  // send/retry button next to each unpaid member.
  type MissingRow = ExpectedRow & {
    reminder: ReminderState;
    canRemind: boolean;
  };
  const missing: MissingRow[] = [];
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
      const reminder = reminderState({
        hasEmail: Boolean(m.email),
        optedOut: m.emailUnsubscribed,
        statuses: m.emails.map((e) => e.status),
      });
      missing.push({
        ...row,
        reminder,
        // Can be sent now: emailable, and not already successfully reminded.
        canRemind:
          reminder !== "noEmail" &&
          reminder !== "optedOut" &&
          reminder !== "sent",
      });
    } else if (total.lt(m.tier.minContribution)) {
      belowMin.push(row);
    }
    // else: reached the minimum — allocated, not listed here.
  }
  // How many unpaid members the "Remind all" button would actually email.
  const remindPendingCount = missing.filter((m) => m.canRemind).length;

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

  // Confirmed mints still awaiting a member notification (drives the Notify-all
  // button + its count). Notifiable = a CONFIRMED MINT to a member with an
  // email; "pending" = no SENT allocation-confirmation email yet.
  const notifyPendingCount = period.tokenOperations.filter(
    (op) =>
      op.type === "MINT" &&
      op.status === "CONFIRMED" &&
      op.member?.email &&
      !op.emails.some((e) => e.status === "SENT"),
  ).length;

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

      <Tabs
        active={active}
        items={[
          { value: "ready", label: tabLabel(t("tabs.ready"), ready.length) },
          {
            value: "deposits",
            label: tabLabel(t("tabs.deposits"), period.bankTransactions.length),
          },
          {
            value: "mints",
            label: tabLabel(t("tabs.mints"), period.tokenOperations.length),
          },
          {
            value: "missing",
            label: tabLabel(t("tabs.missing"), missing.length),
          },
          {
            value: "belowMin",
            label: tabLabel(t("tabs.belowMin"), belowMin.length),
          },
        ]}
      />

      {active === "ready" && (
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
      )}

      {active === "deposits" && (
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
                          <div className="flex items-center justify-end gap-2">
                            {/* Matched but not yet allocated: let the admin
                                attach a manual allocation they already made for
                                this member instead of running a fresh one. */}
                            {b.member && (
                              <AttachAllocationDialog
                                bankTransactionId={b.id}
                                memberName={`${b.member.firstName} ${b.member.lastName}`.trim()}
                                depositAmount={`${b.amount.toString()} ${b.currency}`}
                              />
                            )}
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
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </section>
      )}

      {active === "mints" && (
        <section className="space-y-3">
          <h2 className="font-heading text-lg font-medium">
            {t("mints.title")}
          </h2>
          <NotifyAllButton
            periodId={period.id}
            pendingCount={notifyPendingCount}
          />
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("mints.date")}</TableHead>
                <TableHead>{t("mints.member")}</TableHead>
                <TableHead>{t("mints.tier")}</TableHead>
                <TableHead className="text-right">
                  {t("mints.amount")}
                </TableHead>
                <TableHead>{t("mints.status")}</TableHead>
                <TableHead>{t("notify.column")}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {period.tokenOperations.length === 0 ? (
                <TableEmpty colSpan={7}>{t("mints.empty")}</TableEmpty>
              ) : (
                period.tokenOperations.map((op) => {
                  const memberName = op.member
                    ? `${op.member.firstName} ${op.member.lastName}`.trim()
                    : "—";
                  const notif = mintNotification({
                    type: op.type,
                    status: op.status,
                    hasEmail: Boolean(op.member?.email),
                    emailStatuses: op.emails.map((e) => e.status),
                  });
                  return (
                    <TableRow key={op.id}>
                      <TableCell className="text-sm text-muted-foreground">
                        {format.dateTime(op.submittedAt, {
                          dateStyle: "medium",
                        })}
                      </TableCell>
                      <TableCell>
                        {op.member ? (
                          <Link
                            href={`/members/${op.member.id}`}
                            className="hover:underline"
                          >
                            {memberName}
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
                      <TableCell>
                        {notif.badge ? (
                          <Badge variant={notif.badge.variant}>
                            {t(`notify.status.${notif.badge.key}`)}
                          </Badge>
                        ) : (
                          <span className="text-sm text-muted-foreground">
                            —
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="text-right">
                        {notif.action && (
                          <NotifyAllocationButton
                            tokenOperationId={op.id}
                            memberName={memberName}
                            amount={op.amount.toString()}
                            isRetry={notif.action === "retry"}
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
      )}

      {active === "missing" && (
        <section className="space-y-3">
          <div className="space-y-1">
            <h2 className="font-heading text-lg font-medium">
              {t("missing.title", { count: missing.length })}
            </h2>
            <p className="text-sm text-muted-foreground">{t("missing.hint")}</p>
          </div>
          <RemindUnpaidButton
            periodId={period.id}
            pendingCount={remindPendingCount}
          />
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("missing.member")}</TableHead>
                <TableHead>{t("missing.tier")}</TableHead>
                <TableHead className="text-right">
                  {t("missing.minimum")}
                </TableHead>
                <TableHead>{t("remind.column")}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {missing.length === 0 ? (
                <TableEmpty colSpan={5}>{t("missing.empty")}</TableEmpty>
              ) : (
                missing.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell>
                      <Link
                        href={`/members/${m.id}`}
                        className="hover:underline"
                      >
                        {m.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {m.tierName}
                    </TableCell>
                    <TableCell className="text-right text-sm text-muted-foreground">
                      {m.min}
                    </TableCell>
                    <TableCell>
                      <Badge variant={reminderBadgeVariant(m.reminder)}>
                        {t(`remind.status.${m.reminder}`)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right">
                      {m.canRemind && (
                        <RemindMemberButton
                          periodId={period.id}
                          memberId={m.id}
                          memberName={m.name}
                          isRetry={m.reminder === "failed"}
                        />
                      )}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </section>
      )}

      {active === "belowMin" && (
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
              {belowMin.length === 0 ? (
                <TableEmpty colSpan={4}>{t("belowMin.empty")}</TableEmpty>
              ) : (
                belowMin.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell>
                      <Link
                        href={`/members/${m.id}`}
                        className="hover:underline"
                      >
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
                ))
              )}
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

// Per-mint notification state for the mints table. Only CONFIRMED mints to a
// member with an email can be notified; everything else shows no badge/button.
//   - sent:    a SENT allocation-confirmation email exists → no action
//   - failed:  only FAILED/QUEUED attempts so far → "Retry"
//   - notSent: no email yet → "Send"
function mintNotification(op: {
  type: "MINT" | "BURN" | "TRANSFER";
  status: "PENDING" | "CONFIRMED" | "FAILED";
  hasEmail: boolean;
  emailStatuses: Array<"QUEUED" | "SENT" | "FAILED">;
}): {
  badge: { variant: "success" | "destructive" | "outline"; key: string } | null;
  action: "send" | "retry" | null;
} {
  if (op.type !== "MINT" || op.status !== "CONFIRMED" || !op.hasEmail) {
    return { badge: null, action: null };
  }
  if (op.emailStatuses.includes("SENT")) {
    return { badge: { variant: "success", key: "sent" }, action: null };
  }
  if (op.emailStatuses.length > 0) {
    return {
      badge: { variant: "destructive", key: "failed" },
      action: "retry",
    };
  }
  return { badge: { variant: "outline", key: "notSent" }, action: "send" };
}

// Per-member payment-reminder state for the Missing tab. "noEmail"/"optedOut"
// mean the member can't be reminded (no send button); the rest drive the badge:
//   - sent:    a SENT reminder exists for this period → no action
//   - failed:  only FAILED/QUEUED attempts so far → "Retry"
//   - notSent: emailable, no reminder yet → "Send"
type ReminderState = "noEmail" | "optedOut" | "sent" | "failed" | "notSent";

function reminderState(args: {
  hasEmail: boolean;
  optedOut: boolean;
  statuses: Array<"QUEUED" | "SENT" | "FAILED">;
}): ReminderState {
  if (!args.hasEmail) return "noEmail";
  if (args.optedOut) return "optedOut";
  if (args.statuses.includes("SENT")) return "sent";
  if (args.statuses.length > 0) return "failed";
  return "notSent";
}

function reminderBadgeVariant(
  state: ReminderState,
): "success" | "destructive" | "outline" {
  if (state === "sent") return "success";
  if (state === "failed") return "destructive";
  return "outline";
}

function AllocationPeriodDetailSkeleton() {
  return (
    <>
      <Skeleton className="h-4 w-24" />
      <header className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </header>
      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </section>
      <section className="space-y-3">
        <Skeleton className="h-6 w-40" />
        <TableSkeleton columns={5} rows={4} alignRight={2} />
      </section>
      <section className="space-y-3">
        <Skeleton className="h-6 w-32" />
        <TableSkeleton columns={6} rows={4} alignRight={1} />
      </section>
    </>
  );
}

// Tab label with a trailing count, e.g. "Ready (3)". The count shows even when
// zero so the admin can see an empty list without opening the tab.
function tabLabel(label: string, count: number): string {
  return `${label} (${count})`;
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
