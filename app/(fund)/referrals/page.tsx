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

export default async function ReferralsPage() {
  const t = await getTranslations("fund.referrals");

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
        <CardContent className="grid gap-4 pb-4 sm:grid-cols-2">
          <Field label={t("config.bonus")} value="—" hint={t("config.bonusHint")} />
          <Field label={t("config.codeFormat")} value="—" hint={t("config.codeFormatHint")} />
        </CardContent>
      </Card>

      <section className="space-y-3">
        <h2 className="font-heading text-lg font-medium">{t("history.title")}</h2>
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
            <TableEmpty colSpan={6}>{t("history.empty")}</TableEmpty>
          </TableBody>
        </Table>
      </section>
    </>
  );
}

function Field({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div>
      <div className="text-xs tracking-wide text-muted-foreground uppercase">
        {label}
      </div>
      <div className="mt-1 text-base font-medium">{value}</div>
      <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>
    </div>
  );
}
