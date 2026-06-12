// SPDX-License-Identifier: AGPL-3.0-or-later
import { getFormatter, getTranslations } from "next-intl/server";

import { Badge } from "@/components/ui/badge";
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

import { BankTransactionRowActions } from "./bank-transaction-actions";

// Member deposits (INCOMING bank transactions) with manual member
// attribution — the review queue feeding allocations. Period assignment is
// NOT done here: that lives on the Bank screen (inline picker); this table
// shows the period read-only.
export async function DepositsTable({
  fundId,
  onlyUnmatched,
}: {
  fundId: string;
  onlyUnmatched: boolean;
}) {
  const t = await getTranslations("fund.allocations.transactions");
  const format = await getFormatter();

  const transactions = await prisma.bankTransaction.findMany({
    where: {
      fundId,
      direction: "INCOMING",
      ...(onlyUnmatched ? { memberId: null } : {}),
    },
    orderBy: { occurredAt: "desc" },
    take: 100,
    include: {
      member: { select: { firstName: true, lastName: true } },
      allocationPeriod: { select: { label: true } },
    },
  });

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("date")}</TableHead>
          <TableHead>{t("counterpart")}</TableHead>
          <TableHead>{t("reference")}</TableHead>
          <TableHead>{t("member")}</TableHead>
          <TableHead>{t("period")}</TableHead>
          <TableHead className="text-right">{t("amount")}</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {transactions.length === 0 ? (
          <TableEmpty colSpan={7}>{t("empty")}</TableEmpty>
        ) : (
          transactions.map((b) => {
            const memberName = b.member
              ? `${b.member.firstName} ${b.member.lastName}`.trim()
              : null;
            return (
              <TableRow key={b.id}>
                <TableCell className="text-sm text-muted-foreground">
                  {format.dateTime(b.occurredAt, { dateStyle: "medium" })}
                </TableCell>
                <TableCell>
                  <div className="text-sm">{b.counterpartName ?? "—"}</div>
                  <div className="font-mono text-xs text-muted-foreground">
                    {b.counterpartIban ?? ""}
                  </div>
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {b.counterpartReference ?? b.remittanceInfo ?? "—"}
                </TableCell>
                <TableCell>
                  {memberName ? (
                    <span className="text-sm">{memberName}</span>
                  ) : (
                    <Badge variant="warning">{t("unmatched")}</Badge>
                  )}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {b.allocationPeriod?.label ?? "—"}
                </TableCell>
                <TableCell className="text-right font-medium">
                  {b.amount.toString()} {b.currency}
                </TableCell>
                <TableCell className="text-right">
                  <BankTransactionRowActions
                    bankTransactionId={b.id}
                    isMatched={b.memberId !== null}
                  />
                </TableCell>
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  );
}
