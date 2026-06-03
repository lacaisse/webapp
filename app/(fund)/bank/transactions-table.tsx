// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";

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

import { fetchStoredBankTransactions, TRANSACTIONS_PAGE_SIZE } from "./data";
import { resolveRangeWindow, type RangePreset } from "./range";

// Server-rendered, offset-paginated view of the locally-stored bank
// transactions for a date range. Newest-first; `amount` is the unsigned
// magnitude, so `direction` carries the sign for display.
export async function BankTransactionsTable({
  fundId,
  range,
  from,
  to,
  page,
}: {
  fundId: string;
  range: RangePreset;
  from?: string;
  to?: string;
  page: number;
}) {
  const t = await getTranslations("fund.bank.transactions");
  const format = await getFormatter();

  const window = resolveRangeWindow(range, from, to);
  const { transactions, total } = await fetchStoredBankTransactions({
    fundId,
    from: window.from,
    to: window.to,
    page,
    pageSize: TRANSACTIONS_PAGE_SIZE,
  });

  const totalPages = Math.max(1, Math.ceil(total / TRANSACTIONS_PAGE_SIZE));
  const clampedPage = Math.min(Math.max(page, 1), totalPages);

  return (
    <div className="space-y-3">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("date")}</TableHead>
            <TableHead>{t("counterpart")}</TableHead>
            <TableHead>{t("reference")}</TableHead>
            <TableHead>{t("member")}</TableHead>
            <TableHead className="text-right">{t("amount")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {transactions.length === 0 ? (
            <TableEmpty colSpan={5}>{t("emptyRange")}</TableEmpty>
          ) : (
            transactions.map((tx) => {
              const signed =
                tx.direction === "OUTGOING"
                  ? -Number(tx.amount)
                  : Number(tx.amount);
              return (
                <TableRow key={tx.id}>
                  <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                    {format.dateTime(new Date(tx.occurredAt), {
                      dateStyle: "medium",
                    })}
                  </TableCell>
                  <TableCell>
                    <div className="text-sm">{tx.counterpartName ?? "—"}</div>
                    {tx.counterpartIban && (
                      <div className="font-mono text-xs text-muted-foreground">
                        {tx.counterpartIban}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {tx.remittanceInfo ?? "—"}
                  </TableCell>
                  <TableCell className="text-sm">
                    {tx.memberName ?? (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell
                    className={cn(
                      "text-right font-medium tabular-nums",
                      signed >= 0 ? "text-success" : "text-foreground",
                    )}
                  >
                    {format.number(signed, {
                      style: "currency",
                      currency: tx.currency,
                    })}
                  </TableCell>
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>

      {total > 0 && (
        <PageNav
          range={range}
          from={from}
          to={to}
          page={clampedPage}
          totalPages={totalPages}
          summary={t("total", { count: total })}
          labels={{ prev: t("prev"), next: t("next") }}
        />
      )}
    </div>
  );
}

function PageNav({
  range,
  from,
  to,
  page,
  totalPages,
  summary,
  labels,
}: {
  range: RangePreset;
  from?: string;
  to?: string;
  page: number;
  totalPages: number;
  summary: string;
  labels: { prev: string; next: string };
}) {
  const hasPrev = page > 1;
  const hasNext = page < totalPages;

  // Preserve the active range across page links; custom also needs from/to.
  const baseQuery: Record<string, string> = { range };
  if (range === "custom") {
    if (from) baseQuery.from = from;
    if (to) baseQuery.to = to;
  }

  return (
    <div className="flex items-center justify-between gap-2 pt-1 text-sm">
      <span className="text-xs text-muted-foreground tabular-nums">
        {summary}
      </span>
      <div className="flex items-center gap-2">
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
    </div>
  );
}
