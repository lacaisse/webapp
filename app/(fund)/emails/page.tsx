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
import { EmailStatus } from "@/services/db/generated/enums";
import { prisma } from "@/services/db/prisma";
import { requireCurrentFund } from "@/services/fund/server";
import { EmailDetailDialog } from "./email-detail-dialog";

const TABS = [
  { value: "all" },
  { value: "queued" },
  { value: "sent" },
  { value: "failed" },
] as const;

type TabValue = (typeof TABS)[number]["value"];

function statusFilterFor(tab: TabValue) {
  switch (tab) {
    case "all":
      return undefined;
    case "queued":
      return EmailStatus.QUEUED;
    case "sent":
      return EmailStatus.SENT;
    case "failed":
      return EmailStatus.FAILED;
  }
}

export default async function EmailsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const t = await getTranslations("fund.emails");
  const format = await getFormatter();
  const fund = await requireCurrentFund();
  const sp = await searchParams;
  const active = resolveActiveTab(sp.tab, TABS);

  const status = statusFilterFor(active);
  const emails = await prisma.email.findMany({
    where: { fundId: fund.id, ...(status ? { status } : {}) },
    orderBy: { queuedAt: "desc" },
    take: 200,
    select: {
      id: true,
      type: true,
      toEmail: true,
      subject: true,
      status: true,
      errorMessage: true,
      resendMessageId: true,
      bodyText: true,
      bodyHtml: true,
      queuedAt: true,
      sentAt: true,
      failedAt: true,
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
            <TableHead>{t("columns.queued")}</TableHead>
            <TableHead>{t("columns.recipient")}</TableHead>
            <TableHead>{t("columns.type")}</TableHead>
            <TableHead>{t("columns.subject")}</TableHead>
            <TableHead>{t("columns.status")}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {emails.length === 0 ? (
            <TableEmpty colSpan={6}>{t("empty")}</TableEmpty>
          ) : (
            emails.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="text-sm text-muted-foreground">
                  {format.dateTime(e.queuedAt, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </TableCell>
                <TableCell className="text-sm">{e.toEmail}</TableCell>
                <TableCell>
                  <code className="text-xs">{e.type}</code>
                </TableCell>
                <TableCell className="text-sm">{e.subject}</TableCell>
                <TableCell>
                  <StatusBadge status={e.status} />
                </TableCell>
                <TableCell className="text-right">
                  <EmailDetailDialog
                    email={{
                      id: e.id,
                      type: e.type,
                      toEmail: e.toEmail,
                      subject: e.subject,
                      status: e.status,
                      errorMessage: e.errorMessage,
                      resendMessageId: e.resendMessageId,
                      bodyText: e.bodyText,
                      bodyHtml: e.bodyHtml,
                      queuedAt: e.queuedAt.toISOString(),
                      sentAt: e.sentAt?.toISOString() ?? null,
                      failedAt: e.failedAt?.toISOString() ?? null,
                    }}
                  />
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </>
  );
}

function StatusBadge({
  status,
}: {
  status: "QUEUED" | "SENT" | "FAILED";
}) {
  if (status === "SENT") return <Badge variant="success">{status}</Badge>;
  if (status === "FAILED")
    return <Badge variant="destructive">{status}</Badge>;
  return <Badge variant="warning">{status}</Badge>;
}
