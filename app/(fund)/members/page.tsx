// SPDX-License-Identifier: AGPL-3.0-or-later
import { Suspense } from "react";
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";

import { TableSearch } from "@/components/table-search";
import { TableSkeleton } from "@/components/table-skeleton";
import { Badge, badgeVariants } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
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
import { parseCardNumber, searchTokens } from "@/lib/search";
import { cn } from "@/lib/utils";
import { MemberStatus } from "@/services/db/generated/enums";
import { prisma } from "@/services/db/prisma";
import { requireCurrentFund } from "@/services/fund/server";
import { contributionApplies } from "@/services/member/contribution";
import { AddCardDialog } from "./add-card-dialog";
import { BulkActionsBar } from "./bulk-actions-bar";
import { InviteMemberDialog } from "./invite-member-dialog";
import { MemberImportDialog } from "./member-import-dialog";
import { MemberRowActions } from "./member-row-actions";
import {
  MemberSelectionProvider,
  RowCheckbox,
  SelectAllCheckbox,
} from "./selection";
import { StatusChangeDialog } from "./status-change-dialog";
import { MemberTierPicker } from "./tier-picker";

const TABS = [
  { value: "all" },
  { value: "new" },
  { value: "active" },
  { value: "inactive" },
  { value: "paused" },
  { value: "stopped" },
  { value: "rejected" },
] as const;

type TabValue = (typeof TABS)[number]["value"];

// Tab → status filter. One tab per status (issue #17); "new" covers members
// who signed up / were added but aren't active yet.
function statusFilterFor(tab: TabValue) {
  switch (tab) {
    case "all":
      return undefined;
    case "new":
      return MemberStatus.NEW;
    case "active":
      return MemberStatus.ACTIVE;
    case "inactive":
      return MemberStatus.INACTIVE;
    case "paused":
      return MemberStatus.PAUSED;
    case "stopped":
      return MemberStatus.STOPPED;
    case "rejected":
      return MemberStatus.REJECTED;
  }
}

// Free-text member search (issue #29): match on the member's name — each
// whitespace token must hit a first/last name — OR on one of their cards by
// serial / card number. A clean integer query also matches a card number
// exactly.
function memberSearchWhere(q: string) {
  const tokens = searchTokens(q);
  const number = parseCardNumber(q);
  return {
    OR: [
      {
        AND: tokens.map((tok) => ({
          OR: [
            { firstName: { contains: tok, mode: "insensitive" as const } },
            { lastName: { contains: tok, mode: "insensitive" as const } },
          ],
        })),
      },
      {
        cards: {
          some: {
            OR: [
              { serialNumber: { contains: q, mode: "insensitive" as const } },
              ...(number !== null ? [{ number }] : []),
            ],
          },
        },
      },
    ],
  };
}

// Synchronous shell: the header (with its tier-aware import dialog) and the
// searchable member table each stream behind their own <Suspense>; the table
// boundary is keyed on tab+query so it re-shows the skeleton on filter changes.
export default function MembersPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; q?: string }>;
}) {
  return (
    <>
      <Suspense fallback={<MembersHeaderSkeleton />}>
        <MembersHeader />
      </Suspense>
      <Suspense fallback={<MembersToolbarSkeleton />}>
        <MembersContent searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function MembersHeader() {
  const t = await getTranslations("fund.members");
  const fund = await requireCurrentFund();
  const tiers = await prisma.allocationTier.findMany({
    where: { fundId: fund.id, archivedAt: null },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    select: { name: true },
  });

  return (
    <header className="flex items-end justify-between gap-4">
      <div className="space-y-1">
        <h1 className="font-heading text-2xl font-medium">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </div>
      <div className="flex items-center gap-2">
        <MemberImportDialog
          triggerLabel={t("import.button")}
          tiers={tiers.map((tier) => tier.name)}
          showContribution={contributionApplies(
            fund.allocationMode,
            tiers.length,
          )}
        />
        <InviteMemberDialog triggerLabel={t("invite")} />
      </div>
    </header>
  );
}

async function MembersContent({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; q?: string }>;
}) {
  const t = await getTranslations("fund.members");
  const tStatus = await getTranslations("members.admin.status.values");
  const format = await getFormatter();
  const fund = await requireCurrentFund();
  const sp = await searchParams;
  const active = resolveActiveTab(sp.tab, TABS);
  const q = sp.q?.trim() || null;

  const status = statusFilterFor(active);
  const [members, tiers, statusCounts] = await Promise.all([
    prisma.member.findMany({
      where: {
        fundId: fund.id,
        ...(status ? { status } : {}),
        ...(q ? memberSearchWhere(q) : {}),
      },
      orderBy: { createdAt: "desc" },
      include: {
        // allocationAmount is the tier's target amount ("montant cible") shown
        // under the tier picker (issue #69).
        tier: { select: { name: true, allocationAmount: true } },
        cards: {
          select: { id: true, number: true, serialNumber: true },
          orderBy: [{ number: { sort: "asc", nulls: "last" } }],
        },
        // Most recent incoming deposit = the member's last received
        // contribution, shown alongside the target in the tier column.
        bankTransactions: {
          where: { direction: "INCOMING" },
          orderBy: { occurredAt: "desc" },
          take: 1,
          select: { amount: true, currency: true },
        },
      },
    }),
    prisma.allocationTier.findMany({
      where: { fundId: fund.id, archivedAt: null },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      select: { id: true, name: true },
    }),
    // Per-status counts for the tab badges (issue #104). Respects the active
    // search query so counts match what each tab would actually show, but
    // not the tab's own status filter — every tab needs every status's count.
    prisma.member.groupBy({
      by: ["status"],
      where: {
        fundId: fund.id,
        ...(q ? memberSearchWhere(q) : {}),
      },
      _count: true,
    }),
  ]);

  // The committed-contribution line only applies to FIXED_PERIOD funds with
  // tiers (issue #82).
  const showContribution = contributionApplies(
    fund.allocationMode,
    tiers.length,
  );

  const countByStatus = new Map(
    statusCounts.map((row) => [row.status, row._count]),
  );
  const totalMemberCount = statusCounts.reduce(
    (sum, row) => sum + row._count,
    0,
  );
  const countForTab = (tab: TabValue) => {
    if (tab === "all") return totalMemberCount;
    return countByStatus.get(statusFilterFor(tab) as MemberStatus) ?? 0;
  };

  return (
    <MemberSelectionProvider
      key={`${active}:${q ?? ""}`}
      allIds={members.map((m) => m.id)}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          active={active}
          items={TABS.map((tab) => ({
            value: tab.value,
            label: `${t(`tabs.${tab.value}`)} (${format.number(countForTab(tab.value))})`,
          }))}
        />
        <TableSearch placeholder={t("searchPlaceholder")} />
      </div>

      <BulkActionsBar tiers={tiers} />

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10">
              <SelectAllCheckbox />
            </TableHead>
            <TableHead>{t("columns.name")}</TableHead>
            <TableHead>{t("columns.email")}</TableHead>
            <TableHead>{t("columns.status")}</TableHead>
            <TableHead>{t("columns.tier")}</TableHead>
            <TableHead>{t("columns.cards")}</TableHead>
            <TableHead>{t("columns.joined")}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.length === 0 ? (
            <TableEmpty colSpan={8}>{t("empty")}</TableEmpty>
          ) : (
            members.map((m) => {
              const fullName = `${m.firstName} ${m.lastName}`.trim();
              return (
                <TableRow key={m.id}>
                  <TableCell className="w-10">
                    <RowCheckbox id={m.id} />
                  </TableCell>
                  <TableCell className="font-medium">
                    <Link
                      href={`/members/${m.id}`}
                      className="hover:underline"
                    >
                      {fullName}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <div className="text-sm">{m.email}</div>
                    {!m.emailVerifiedAt && (
                      <div className="text-xs text-warning">
                        {t("unverified")}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={m.status} label={tStatus(m.status)} />
                  </TableCell>
                  <TableCell>
                    <MemberTierPicker
                      memberId={m.id}
                      currentTierId={m.tierId}
                      tiers={tiers}
                    />
                    <dl className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                      <div className="flex gap-1">
                        <dt>{t("contribution.target")}:</dt>
                        <dd className="tabular-nums text-foreground">
                          {m.tier
                            ? m.tier.allocationAmount.toString()
                            : t("contribution.none")}
                        </dd>
                      </div>
                      {showContribution && m.contributionAmount && (
                        <div className="flex gap-1">
                          <dt>{t("contribution.committed")}:</dt>
                          <dd className="tabular-nums text-foreground">
                            {m.contributionAmount.toString()}
                          </dd>
                        </div>
                      )}
                      <div className="flex gap-1">
                        <dt>{t("contribution.lastReceived")}:</dt>
                        <dd className="tabular-nums text-foreground">
                          {m.bankTransactions[0]
                            ? `${m.bankTransactions[0].amount.toString()} ${m.bankTransactions[0].currency}`
                            : t("contribution.none")}
                        </dd>
                      </div>
                    </dl>
                  </TableCell>
                  <TableCell>
                    {m.cards.length === 0 ? (
                      <span className="text-sm text-muted-foreground">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {primaryFirst(m.cards, m.primaryCardId).map((card) => (
                          <Link
                            key={card.id}
                            href={`/cards/${card.id}`}
                            className={cn(
                              badgeVariants({ variant: "outline" }),
                              "transition-colors hover:bg-muted",
                            )}
                          >
                            {card.number !== null && (
                              <span className="tabular-nums">
                                #{card.number}
                              </span>
                            )}
                            <span className="font-mono text-muted-foreground">
                              {card.serialNumber}
                            </span>
                          </Link>
                        ))}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {format.dateTime(m.joinedAt, { dateStyle: "medium" })}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="inline-flex items-center gap-1">
                      {!m.primaryCardId &&
                        (m.status === "NEW" || m.status === "ACTIVE") && (
                          <MemberRowActions
                            memberId={m.id}
                            memberName={fullName}
                            emailVerified={m.emailVerifiedAt !== null}
                            alreadyActive={m.status === "ACTIVE"}
                          />
                        )}
                      {m.status === "ACTIVE" && m.primaryCardId && (
                        <AddCardDialog
                          memberId={m.id}
                          memberName={fullName}
                        />
                      )}
                      <StatusChangeDialog
                        memberId={m.id}
                        memberName={fullName}
                        currentStatus={m.status}
                      />
                    </div>
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </MemberSelectionProvider>
  );
}

// Surface the member's primary card first; the rest keep their incoming
// (card-number ascending) order.
function primaryFirst<T extends { id: string }>(
  cards: T[],
  primaryCardId: string | null,
): T[] {
  if (!primaryCardId) return cards;
  const primary = cards.find((c) => c.id === primaryCardId);
  if (!primary) return cards;
  return [primary, ...cards.filter((c) => c.id !== primaryCardId)];
}

function StatusBadge({ status, label }: { status: string; label: string }) {
  const variant: "default" | "success" | "warning" | "destructive" =
    status === "ACTIVE"
      ? "success"
      : status === "NEW" || status === "PAUSED"
        ? "warning"
        : status === "REJECTED"
          ? "destructive"
          : "default"; // INACTIVE, STOPPED
  return <Badge variant={variant}>{label}</Badge>;
}

function MembersHeaderSkeleton() {
  return (
    <header className="flex items-end justify-between gap-4">
      <div className="space-y-1">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-72" />
      </div>
      <div className="flex items-center gap-2">
        <Skeleton className="h-9 w-28" />
        <Skeleton className="h-9 w-28" />
      </div>
    </header>
  );
}

function MembersToolbarSkeleton() {
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-2">
          {Array.from({ length: 7 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-16" />
          ))}
        </div>
        <Skeleton className="h-9 w-48" />
      </div>
      <TableSkeleton columns={8} alignRight={1} />
    </>
  );
}
