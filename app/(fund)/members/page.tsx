// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from "next/link";
import { getFormatter, getTranslations } from "next-intl/server";

import { TableSearch } from "@/components/table-search";
import { Badge, badgeVariants } from "@/components/ui/badge";
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
import { AddCardDialog } from "./add-card-dialog";
import { InviteMemberDialog } from "./invite-member-dialog";
import { MemberImportDialog } from "./member-import-dialog";
import { MemberRowActions } from "./member-row-actions";
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

export default async function MembersPage({
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
  const [members, tiers] = await Promise.all([
    prisma.member.findMany({
      where: {
        fundId: fund.id,
        ...(status ? { status } : {}),
        ...(q ? memberSearchWhere(q) : {}),
      },
      orderBy: { createdAt: "desc" },
      include: {
        tier: { select: { name: true } },
        cards: {
          select: { id: true, number: true, serialNumber: true },
          orderBy: [{ number: { sort: "asc", nulls: "last" } }],
        },
      },
    }),
    prisma.allocationTier.findMany({
      where: { fundId: fund.id, archivedAt: null },
      orderBy: [{ position: "asc" }, { createdAt: "asc" }],
      select: { id: true, name: true },
    }),
  ]);

  return (
    <>
      <header className="flex items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="font-heading text-2xl font-medium">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </div>
        <div className="flex items-center gap-2">
          <MemberImportDialog
            triggerLabel={t("import.button")}
            tiers={tiers.map((tier) => tier.name)}
          />
          <InviteMemberDialog triggerLabel={t("invite")} />
        </div>
      </header>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          active={active}
          items={TABS.map((tab) => ({
            value: tab.value,
            label: t(`tabs.${tab.value}`),
          }))}
        />
        <TableSearch placeholder={t("searchPlaceholder")} />
      </div>

      <Table>
        <TableHeader>
          <TableRow>
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
            <TableEmpty colSpan={7}>{t("empty")}</TableEmpty>
          ) : (
            members.map((m) => {
              const fullName = `${m.firstName} ${m.lastName}`.trim();
              return (
                <TableRow key={m.id}>
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
    </>
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
