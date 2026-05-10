import { getTranslations } from "next-intl/server";

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
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export default async function FundDashboardPage() {
  const t = await getTranslations("fund.dashboard");

  return (
    <>
      <header className="space-y-1">
        <h1 className="font-heading text-2xl font-medium">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("description")}</p>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard label={t("kpi.totalBalance")} value="—" hint={t("kpi.totalBalanceHint")} />
        <KpiCard label={t("kpi.activeMembers")} value="—" hint={t("kpi.activeMembersHint")} />
        <KpiCard label={t("kpi.allocatedThisMonth")} value="—" hint={t("kpi.allocatedThisMonthHint")} />
        <KpiCard label={t("kpi.spentThisMonth")} value="—" hint={t("kpi.spentThisMonthHint")} />
      </section>

      <section className="grid gap-3 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t("tiers.title")}</CardTitle>
            <CardDescription>{t("tiers.description")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 pb-4">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="flex items-center justify-between rounded-md bg-muted/40 px-3 py-2"
              >
                <div>
                  <div className="text-sm font-medium">
                    {t("tiers.tierLabel", { n: i })}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {t("tiers.range", { min: "—", max: "—" })}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-medium">—</div>
                  <div className="text-xs text-muted-foreground">
                    {t("tiers.members", { n: 0 })}
                  </div>
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("citizenpay.title")}</CardTitle>
            <CardDescription>{t("citizenpay.description")}</CardDescription>
          </CardHeader>
          <CardContent className="pb-4">
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
              <dt className="text-muted-foreground">{t("citizenpay.account")}</dt>
              <dd>—</dd>
              <dt className="text-muted-foreground">{t("citizenpay.terminal")}</dt>
              <dd>—</dd>
              <dt className="text-muted-foreground">{t("citizenpay.lastSync")}</dt>
              <dd>—</dd>
            </dl>
          </CardContent>
        </Card>
      </section>

      <section className="space-y-3">
        <h2 className="font-heading text-lg font-medium">
          {t("recentActivity.title")}
        </h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("recentActivity.date")}</TableHead>
              <TableHead>{t("recentActivity.event")}</TableHead>
              <TableHead>{t("recentActivity.subject")}</TableHead>
              <TableHead className="text-right">{t("recentActivity.amount")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableEmpty colSpan={4}>{t("recentActivity.empty")}</TableEmpty>
          </TableBody>
        </Table>
      </section>
    </>
  );
}

function KpiCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <Card size="sm">
      <CardHeader>
        <CardDescription>{label}</CardDescription>
        <CardTitle className="text-2xl">{value}</CardTitle>
      </CardHeader>
      <CardContent className="pb-3">
        <p className="text-xs text-muted-foreground">{hint}</p>
      </CardContent>
    </Card>
  );
}
