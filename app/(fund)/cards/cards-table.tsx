// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { getBalances } from "@/services/alchemy/balances";
import { formatTokenAmount } from "@/services/alchemy/format";
import {
  type CardStatus as CardStatusEnum,
  CardStatus,
} from "@/services/db/generated/enums";
import { prisma } from "@/services/db/prisma";

import { CardRowActions } from "./card-row-actions";

const PAGE_SIZE = 50;

export type CardsTab = "all" | "active" | "lost" | "blocked";

// Tab filters work on two independent axes:
//   - `lost`: reportedLostAt is not null (regardless of status)
//   - status filters: ACTIVE / BLOCKED
// So a lost+blocked card shows up in both the "lost" and "blocked" tabs.
// `q` is an optional case-insensitive contains-match against the card's
// serial number — admins typically search by the printed number.
function whereFor(tab: CardsTab, fundId: string, q: string | null) {
  const search = q
    ? { serialNumber: { contains: q, mode: "insensitive" as const } }
    : {};
  const baseWhere = { fundId, ...search };
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

export async function CardsTable({
  fund,
  tab,
  page,
  q,
}: {
  fund: {
    id: string;
    tokenAddress: string | null;
    tokenChainId: number;
    tokenDecimals: number | null;
    tokenSymbol: string | null;
  };
  tab: CardsTab;
  page: number;
  q: string | null;
}) {
  const t = await getTranslations("fund.cards");
  const format = await getFormatter();

  const where = whereFor(tab, fund.id, q);

  // Count + page fetch in parallel — count is cheap on the indexed (fundId,
  // status) / (fundId) shapes and lets the pager show totals.
  const [total, pageCards] = await Promise.all([
    prisma.card.count({ where }),
    prisma.card.findMany({
      where,
      // By card number ascending; unnumbered cards last, newest-first among them.
      orderBy: [{ number: { sort: "asc", nulls: "last" } }, { createdAt: "desc" }],
      // Clamp the page to a non-negative offset; the renderer will clamp
      // visually too.
      skip: Math.max(0, (page - 1) * PAGE_SIZE),
      take: PAGE_SIZE,
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
    }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const clampedPage = Math.min(Math.max(page, 1), totalPages);

  // On-chain balances via Alchemy. Cards without an `account` (CP hasn't
  // returned one yet) are excluded; the column renders "—" for them. If
  // the token isn't configured or Alchemy fails, we degrade to no balances
  // rather than blanking the page.
  const balanceByAddress = new Map<string, string>();
  const canShowBalances =
    fund.tokenAddress != null && fund.tokenDecimals != null;
  if (canShowBalances) {
    const addresses = pageCards
      .map((c) => c.account)
      .filter((a): a is string => Boolean(a));
    if (addresses.length > 0) {
      try {
        const balances = await getBalances({
          chainId: fund.tokenChainId,
          contractAddress: fund.tokenAddress!,
          addresses,
        });
        for (const b of balances) balanceByAddress.set(b.address, b.rawBalance);
      } catch (e) {
        console.warn("[cards] alchemy balances failed", e);
      }
    }
  }

  // Resolve the page's source serials (mirror of CP's "pull-from" card) to
  // local cards in one query, for a labelled link. A serial with no local row
  // (source exists on CP only) renders as the raw serial.
  const sourceSerials = [
    ...new Set(
      pageCards
        .map((c) => c.sourceSerial)
        .filter((s): s is string => Boolean(s)),
    ),
  ];
  const sourceCards =
    sourceSerials.length > 0
      ? await prisma.card.findMany({
          where: { fundId: fund.id, serialNumber: { in: sourceSerials } },
          select: {
            id: true,
            serialNumber: true,
            number: true,
            holderName: true,
            member: { select: { firstName: true, lastName: true } },
          },
        })
      : [];
  const sourceBySerial = new Map(sourceCards.map((s) => [s.serialNumber, s]));

  return (
    <div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("columns.number")}</TableHead>
            <TableHead>{t("columns.serial")}</TableHead>
            <TableHead>{t("columns.holder")}</TableHead>
            <TableHead>{t("columns.member")}</TableHead>
            <TableHead>{t("columns.source")}</TableHead>
            <TableHead>{t("columns.status")}</TableHead>
            <TableHead className="text-right">
              {t("columns.balance")}
            </TableHead>
            <TableHead>{t("columns.issued")}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {pageCards.length === 0 ? (
            <TableEmpty colSpan={9}>{t("empty")}</TableEmpty>
          ) : (
            pageCards.map((c) => {
              // Unattached cards (imported from CitizenPay before any member
              // exists locally) have no `member` — fall back to holderName
              // and show "—" in the member column.
              const memberName = c.member
                ? `${c.member.firstName} ${c.member.lastName}`.trim()
                : "";
              const holderLabel = c.holderName || memberName || c.serialNumber;
              const isPrimary = c.member?.primaryCardId === c.id;
              const isLost = c.reportedLostAt !== null;
              const rawBalance = c.account
                ? balanceByAddress.get(c.account)
                : undefined;
              const formattedBalance =
                rawBalance !== undefined && fund.tokenDecimals != null
                  ? formatTokenAmount(rawBalance, fund.tokenDecimals)
                  : null;
              return (
                <TableRow key={c.id}>
                  <TableCell className="tabular-nums text-sm text-muted-foreground">
                    {c.number ?? "—"}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    <Link href={`/cards/${c.id}`} className="hover:underline">
                      {c.serialNumber}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Link
                      href={`/cards/${c.id}`}
                      className="text-sm hover:underline"
                    >
                      {holderLabel}
                    </Link>
                    {isPrimary && (
                      <div className="text-xs text-muted-foreground">
                        {t("primary")}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {memberName || "—"}
                  </TableCell>
                  <TableCell>
                    <SourceCell
                      sourceSerial={c.sourceSerial}
                      source={
                        c.sourceSerial
                          ? (sourceBySerial.get(c.sourceSerial) ?? null)
                          : null
                      }
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1">
                      <StatusBadge status={c.status} />
                      {isLost && (
                        <Badge variant="warning">{t("badges.lost")}</Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-medium tabular-nums">
                    {formattedBalance ?? (
                      <span className="text-muted-foreground">—</span>
                    )}
                    {formattedBalance && fund.tokenSymbol && (
                      <span className="ml-1 text-xs text-muted-foreground">
                        {fund.tokenSymbol}
                      </span>
                    )}
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
                      hasAccount={c.account !== null}
                      tokenSymbol={fund.tokenSymbol}
                      tokenDecimals={fund.tokenDecimals}
                    />
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
      {totalPages > 1 && (
        <PageNumberNav
          tab={tab}
          page={clampedPage}
          totalPages={totalPages}
          q={q}
          labels={{ prev: t("prev"), next: t("next") }}
        />
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: CardStatusEnum }) {
  if (status === "ACTIVE") return <Badge variant="success">{status}</Badge>;
  if (status === "BLOCKED") return <Badge variant="destructive">{status}</Badge>;
  return <Badge>{status}</Badge>;
}

// The card this card pulls from when its own balance can't cover a charge.
// Linked when the source resolves to a local card; raw serial otherwise.
function SourceCell({
  sourceSerial,
  source,
}: {
  sourceSerial: string | null;
  source: {
    id: string;
    serialNumber: string;
    number: number | null;
    holderName: string | null;
    member: { firstName: string; lastName: string } | null;
  } | null;
}) {
  if (!sourceSerial) {
    return <span className="text-muted-foreground">—</span>;
  }
  if (!source) {
    return <span className="font-mono text-xs">{sourceSerial}</span>;
  }
  const holder =
    source.holderName ||
    (source.member
      ? `${source.member.firstName} ${source.member.lastName}`.trim()
      : "");
  const label =
    [source.number !== null ? `#${source.number}` : null, holder]
      .filter(Boolean)
      .join(" · ") || source.serialNumber;
  return (
    <Link href={`/cards/${source.id}`} className="text-sm hover:underline">
      {label}
    </Link>
  );
}

function PageNumberNav({
  tab,
  page,
  totalPages,
  q,
  labels,
}: {
  tab: CardsTab;
  page: number;
  totalPages: number;
  q: string | null;
  labels: { prev: string; next: string };
}) {
  const hasPrev = page > 1;
  const hasNext = page < totalPages;
  const baseQuery = q ? { tab, q } : { tab };
  return (
    <div className="flex items-center justify-end gap-2 pt-3 text-sm">
      <Link
        href={{ query: { ...baseQuery, page: page - 1 } }}
        scroll={false}
        aria-disabled={!hasPrev}
        tabIndex={hasPrev ? undefined : -1}
        className={cn(
          buttonVariants({ variant: "outline", size: "sm" }),
          !hasPrev && "pointer-events-none opacity-50",
        )}
      >
        <ChevronLeft className="size-3.5" />
        {labels.prev}
      </Link>
      <span className="px-1 text-xs text-muted-foreground tabular-nums">
        {page} / {totalPages}
      </span>
      <Link
        href={{ query: { ...baseQuery, page: page + 1 } }}
        scroll={false}
        aria-disabled={!hasNext}
        tabIndex={hasNext ? undefined : -1}
        className={cn(
          buttonVariants({ variant: "outline", size: "sm" }),
          !hasNext && "pointer-events-none opacity-50",
        )}
      >
        {labels.next}
        <ChevronRight className="size-3.5" />
      </Link>
    </div>
  );
}
