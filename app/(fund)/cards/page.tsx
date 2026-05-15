// SPDX-License-Identifier: AGPL-3.0-or-later
import { getFormatter, getTranslations } from "next-intl/server";

import { Badge } from "@/components/ui/badge";
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
import { CardStatus } from "@/services/db/generated/enums";
import { prisma } from "@/services/db/prisma";
import { requireCurrentFund } from "@/services/fund/server";
import { CardRowActions } from "./card-row-actions";

const TABS = [
  { value: "all" },
  { value: "active" },
  { value: "lost" },
  { value: "blocked" },
] as const;

type TabValue = (typeof TABS)[number]["value"];

// Tab filters work on two independent axes:
//   - `lost`: reportedLostAt is not null (regardless of status)
//   - status filters: ACTIVE / BLOCKED
// So a lost+blocked card shows up in both the "lost" and "blocked" tabs.
function whereFor(tab: TabValue, fundId: string) {
  const baseWhere = { member: { fundId } };
  switch (tab) {
    case "all":
      return baseWhere;
    case "active":
      return { ...baseWhere, status: CardStatus.ACTIVE };
    case "blocked":
      return { ...baseWhere, status: CardStatus.BLOCKED };
    case "lost":
      return { ...baseWhere, reportedLostAt: { not: null } };
  }
}

export default async function CardsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const t = await getTranslations("fund.cards");
  const format = await getFormatter();
  const fund = await requireCurrentFund();
  const sp = await searchParams;
  const active = resolveActiveTab(sp.tab, TABS);

  const cards = await prisma.card.findMany({
    where: whereFor(active, fund.id),
    orderBy: { createdAt: "desc" },
    include: {
      member: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          primaryCardId: true,
        },
      },
    },
  });

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

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("columns.serial")}</TableHead>
            <TableHead>{t("columns.holder")}</TableHead>
            <TableHead>{t("columns.member")}</TableHead>
            <TableHead>{t("columns.status")}</TableHead>
            <TableHead>{t("columns.issued")}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {cards.length === 0 ? (
            <TableEmpty colSpan={6}>{t("empty")}</TableEmpty>
          ) : (
            cards.map((c) => {
              const memberName =
                `${c.member.firstName} ${c.member.lastName}`.trim();
              const holderLabel = c.holderName || memberName;
              const isPrimary = c.member.primaryCardId === c.id;
              const isLost = c.reportedLostAt !== null;
              return (
                <TableRow key={c.id}>
                  <TableCell className="font-mono text-xs">
                    {c.serialNumber}
                  </TableCell>
                  <TableCell>
                    <div className="text-sm">{holderLabel}</div>
                    {isPrimary && (
                      <div className="text-xs text-muted-foreground">
                        {t("primary")}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {memberName}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1">
                      <StatusBadge status={c.status} />
                      {isLost && (
                        <Badge variant="warning">{t("badges.lost")}</Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {c.issuedAt
                      ? format.dateTime(c.issuedAt, { dateStyle: "medium" })
                      : "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    <CardRowActions
                      cardId={c.id}
                      status={c.status}
                      isLost={isLost}
                      holderLabel={holderLabel}
                    />
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

function StatusBadge({ status }: { status: "ACTIVE" | "INACTIVE" | "BLOCKED" }) {
  if (status === "ACTIVE") return <Badge variant="success">{status}</Badge>;
  if (status === "BLOCKED") return <Badge variant="destructive">{status}</Badge>;
  return <Badge>{status}</Badge>;
}
