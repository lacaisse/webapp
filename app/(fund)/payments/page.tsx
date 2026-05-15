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
import { prisma } from "@/services/db/prisma";
import { requireCurrentFund } from "@/services/fund/server";
import { BankTransactionRowActions } from "./bank-transaction-actions";

const TABS = [
  { value: "transactions" },
  { value: "unmatched" },
  { value: "payouts" },
] as const;

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const t = await getTranslations("fund.payments");
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

      {active === "transactions" && (
        <IncomingTable fundId={fund.id} onlyUnmatched={false} />
      )}
      {active === "unmatched" && (
        <IncomingTable fundId={fund.id} onlyUnmatched={true} />
      )}
      {active === "payouts" && <PayoutsTable fundId={fund.id} />}
    </>
  );
}

async function IncomingTable({
  fundId,
  onlyUnmatched,
}: {
  fundId: string;
  onlyUnmatched: boolean;
}) {
  const t = await getTranslations("fund.payments.transactions");
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

async function PayoutsTable({ fundId }: { fundId: string }) {
  const t = await getTranslations("fund.payments.payouts");
  const format = await getFormatter();

  const transactions = await prisma.bankTransaction.findMany({
    where: { fundId, direction: "OUTGOING" },
    orderBy: { occurredAt: "desc" },
    take: 100,
    include: { merchant: { select: { name: true } } },
  });

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("date")}</TableHead>
          <TableHead>{t("merchant")}</TableHead>
          <TableHead>{t("reference")}</TableHead>
          <TableHead className="text-right">{t("amount")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {transactions.length === 0 ? (
          <TableEmpty colSpan={4}>{t("empty")}</TableEmpty>
        ) : (
          transactions.map((b) => (
            <TableRow key={b.id}>
              <TableCell className="text-sm text-muted-foreground">
                {format.dateTime(b.occurredAt, { dateStyle: "medium" })}
              </TableCell>
              <TableCell>
                {b.merchant?.name ?? b.counterpartName ?? "—"}
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
  );
}
