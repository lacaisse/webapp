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
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { prisma } from "@/services/db/prisma";
import { requireCurrentFund } from "@/services/fund/server";
import { ReferralForm } from "@/app/(fund)/settings/settings-forms";

export default async function ReferralsPage() {
  const t = await getTranslations("fund.referrals");
  const format = await getFormatter();
  const fund = await requireCurrentFund();

  const referrals = await prisma.referral.findMany({
    where: { fundId: fund.id },
    orderBy: { createdAt: "desc" },
    take: 200,
    include: {
      sponsor: { select: { firstName: true, lastName: true } },
      referee: { select: { firstName: true, lastName: true } },
      rewardOperation: { select: { status: true } },
    },
  });

  return (
    <>
      <header className="space-y-1">
        <h1 className="font-heading text-2xl font-medium">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>{t("config.title")}</CardTitle>
          <CardDescription>{t("config.description")}</CardDescription>
        </CardHeader>
        <CardContent className="pb-4">
          <ReferralForm
            fund={{
              name: fund.name,
              defaultLocale: fund.defaultLocale,
              timezone: fund.timezone,
              allocationMode: fund.allocationMode,
              allocationCutoffDay: fund.allocationCutoffDay,
              logoUrl: fund.logoUrl,
              primaryColor: fund.primaryColor,
              termsUrl: fund.termsUrl,
              privacyUrl: fund.privacyUrl,
              citizenPayFundId: fund.citizenPayFundId,
              referralBonusAmount:
                fund.referralBonusAmount?.toString() ?? null,
              payoutFeePercentage:
                fund.payoutFeePercentage?.toString() ?? null,
              payoutFeeSynced: fund.payoutFeeSynced,
              memberSignupSuccessUrl: fund.memberSignupSuccessUrl,
              merchantSignupSuccessUrl: fund.merchantSignupSuccessUrl,
            }}
          />
        </CardContent>
      </Card>

      <section className="space-y-3">
        <h2 className="font-heading text-lg font-medium">
          {t("history.title")}
        </h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("history.sponsor")}</TableHead>
              <TableHead>{t("history.referee")}</TableHead>
              <TableHead>{t("history.code")}</TableHead>
              <TableHead>{t("history.status")}</TableHead>
              <TableHead>{t("history.reward")}</TableHead>
              <TableHead>{t("history.date")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {referrals.length === 0 ? (
              <TableEmpty colSpan={6}>{t("history.empty")}</TableEmpty>
            ) : (
              referrals.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    {`${r.sponsor.firstName} ${r.sponsor.lastName}`.trim()}
                  </TableCell>
                  <TableCell>
                    {`${r.referee.firstName} ${r.referee.lastName}`.trim()}
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {r.codeUsed}
                  </TableCell>
                  <TableCell>
                    <ReferralStatusBadge
                      status={r.status}
                      mintStatus={r.rewardOperation?.status}
                    />
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {fund.referralBonusAmount?.toString() ?? "—"}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {format.dateTime(r.createdAt, { dateStyle: "medium" })}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </section>
    </>
  );
}

function ReferralStatusBadge({
  status,
  mintStatus,
}: {
  status: "PENDING" | "ACTIVATED";
  mintStatus?: "PENDING" | "CONFIRMED" | "FAILED";
}) {
  if (status === "PENDING") return <Badge variant="warning">{status}</Badge>;
  if (mintStatus === "CONFIRMED") return <Badge variant="success">PAID</Badge>;
  if (mintStatus === "FAILED")
    return <Badge variant="destructive">REWARD FAILED</Badge>;
  return <Badge>REWARD PENDING</Badge>;
}

