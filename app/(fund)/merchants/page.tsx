// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from "next/link";
import { Plus } from "lucide-react";
import { getFormatter, getTranslations } from "next-intl/server";

import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
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
import { MerchantRowActions } from "./merchant-row-actions";

const TABS = [
  { value: "pending" },
  { value: "active" },
  { value: "rejected" },
  { value: "inactive" },
] as const;

// Tab → status filter. Server-side: the merchants admin list per the
// scoping doc plus the review queue (PENDING is the entry point).
const STATUS_BY_TAB = {
  pending: "PENDING",
  active: "ACTIVE",
  rejected: "REJECTED",
  inactive: "INACTIVE",
} as const;

export default async function MerchantsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const t = await getTranslations("fund.merchants");
  const format = await getFormatter();
  const fund = await requireCurrentFund();
  const sp = await searchParams;
  const active = resolveActiveTab(sp.tab, TABS);

  const merchants = await prisma.merchant.findMany({
    where: { fundId: fund.id, status: STATUS_BY_TAB[active] },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      email: true,
      contactName: true,
      status: true,
      emailVerifiedAt: true,
      citizenPayActivatedAt: true,
      reviewedAt: true,
      reviewNote: true,
      joinedAt: true,
    },
  });

  return (
    <>
      <header className="flex items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="font-heading text-2xl font-medium">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("description")}</p>
        </div>
        <button type="button" className={buttonVariants({ variant: "default" })}>
          <Plus />
          {t("invite")}
        </button>
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
            <TableHead>{t("columns.name")}</TableHead>
            <TableHead>{t("columns.contact")}</TableHead>
            <TableHead>{t("columns.emailVerified")}</TableHead>
            <TableHead>{t("columns.citizenpay")}</TableHead>
            <TableHead>{t("columns.joined")}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {merchants.length === 0 ? (
            <TableEmpty colSpan={6}>{t("empty")}</TableEmpty>
          ) : (
            merchants.map((m) => (
              <TableRow key={m.id}>
                <TableCell className="font-medium">
                  <Link
                    href={`/merchants/${m.id}`}
                    className="hover:underline"
                  >
                    {m.name}
                  </Link>
                </TableCell>
                <TableCell>
                  <div className="text-sm">{m.contactName ?? "—"}</div>
                  <div className="text-xs text-muted-foreground">
                    {m.email ?? "—"}
                  </div>
                </TableCell>
                <TableCell>
                  {m.emailVerifiedAt ? (
                    <Badge variant="success">
                      {t("badges.verified")}
                    </Badge>
                  ) : (
                    <Badge variant="warning">
                      {t("badges.unverified")}
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  {m.citizenPayActivatedAt ? (
                    <Badge variant="success">
                      {t("badges.connected")}
                    </Badge>
                  ) : (
                    <Badge>{t("badges.notConnected")}</Badge>
                  )}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {format.dateTime(m.joinedAt, { dateStyle: "medium" })}
                </TableCell>
                <TableCell className="text-right">
                  <MerchantRowActions
                    merchantId={m.id}
                    merchantName={m.name}
                    emailVerified={m.emailVerifiedAt !== null}
                    status={m.status}
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
