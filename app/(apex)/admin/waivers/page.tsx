// SPDX-License-Identifier: AGPL-3.0-or-later
import { getFormatter, getTranslations } from "next-intl/server";

import { Badge } from "@/components/ui/badge";
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
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requireAdmin } from "@/services/auth/dal";
import { prisma } from "@/services/db/prisma";
import {
  formatWaiverCode,
  waiverCodeState,
  type WaiverCodeState,
} from "@/services/fund-setup/waiver-codes";

import { CreateWaiverCodeForm, RevokeWaiverCodeButton } from "./waiver-codes-admin";

// Platform admin: subscription waiver codes. Mint one for a fund that hosts
// for free (a contributor, a non-profit, a school), hand it to the fund's
// owner, who redeems it on Settings → Subscription. The list shows every code
// with its state and the funds it was redeemed by.

const STATE_BADGE = {
  active: "success",
  expired: "outline",
  revoked: "destructive",
  exhausted: "default",
} as const satisfies Record<WaiverCodeState, "success" | "outline" | "destructive" | "default">;

export default async function WaiverCodesPage() {
  await requireAdmin();
  const [t, format] = await Promise.all([getTranslations("admin.waivers"), getFormatter()]);

  const codes = await prisma.subscriptionWaiverCode.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      funds: { select: { id: true, domain: true }, orderBy: { domain: "asc" } },
    },
  });
  const now = new Date();

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("create.title")}</CardTitle>
          <CardDescription>{t("create.description")}</CardDescription>
        </CardHeader>
        <CardContent className="pb-4">
          <CreateWaiverCodeForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("list.title")}</CardTitle>
          <CardDescription>{t("list.description")}</CardDescription>
        </CardHeader>
        <CardContent className="pb-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("list.code")}</TableHead>
                <TableHead>{t("list.label")}</TableHead>
                <TableHead>{t("list.uses")}</TableHead>
                <TableHead>{t("list.expires")}</TableHead>
                <TableHead>{t("list.status")}</TableHead>
                <TableHead>{t("list.redeemedBy")}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {codes.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground">
                    {t("list.empty")}
                  </TableCell>
                </TableRow>
              ) : (
                codes.map((code) => {
                  const state = waiverCodeState(code, now);
                  return (
                    <TableRow key={code.id}>
                      <TableCell className="font-mono whitespace-nowrap">
                        {formatWaiverCode(code.code)}
                      </TableCell>
                      <TableCell>{code.label}</TableCell>
                      <TableCell className="tabular-nums whitespace-nowrap">
                        {code.usedCount} / {code.maxUses}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {code.expiresAt
                          ? format.dateTime(code.expiresAt, { dateStyle: "medium" })
                          : t("list.never")}
                      </TableCell>
                      <TableCell>
                        <Badge variant={STATE_BADGE[state]}>{t(`status.${state}`)}</Badge>
                      </TableCell>
                      <TableCell className="text-sm">
                        {code.funds.length === 0
                          ? "—"
                          : code.funds.map((fund) => fund.domain).join(", ")}
                      </TableCell>
                      <TableCell className="text-right">
                        {state === "active" && <RevokeWaiverCodeButton id={code.id} />}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
