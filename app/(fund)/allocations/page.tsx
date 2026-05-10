import { Plus } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, resolveActiveTab } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const TABS = [
  { value: "history" },
  { value: "tiers" },
  { value: "schedule" },
] as const;

export default async function AllocationsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const t = await getTranslations("fund.allocations");
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

      {active === "history" && <HistoryTab />}
      {active === "tiers" && <TiersTab />}
      {active === "schedule" && <ScheduleTab />}
    </>
  );
}

async function HistoryTab() {
  const t = await getTranslations("fund.allocations.history");
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("date")}</TableHead>
          <TableHead>{t("member")}</TableHead>
          <TableHead>{t("tier")}</TableHead>
          <TableHead>{t("amount")}</TableHead>
          <TableHead>{t("type")}</TableHead>
          <TableHead>{t("status")}</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableEmpty colSpan={7}>{t("empty")}</TableEmpty>
      </TableBody>
    </Table>
  );
}

async function TiersTab() {
  const t = await getTranslations("fund.allocations.tiers");
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-end">
        <button type="button" className={buttonVariants({ variant: "default" })}>
          <Plus />
          {t("addTier")}
        </button>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("name")}</TableHead>
            <TableHead>{t("min")}</TableHead>
            <TableHead>{t("target")}</TableHead>
            <TableHead>{t("max")}</TableHead>
            <TableHead>{t("members")}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableEmpty colSpan={6}>{t("empty")}</TableEmpty>
        </TableBody>
      </Table>
    </div>
  );
}

async function ScheduleTab() {
  const t = await getTranslations("fund.allocations.schedule");
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pb-4 text-sm">
        <Field label={t("mode")} value="—" hint={t("modeHint")} />
        <Field label={t("period")} value="—" hint={t("periodHint")} />
        <Field label={t("nextRun")} value="—" hint={t("nextRunHint")} />
      </CardContent>
    </Card>
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
    <div className="grid grid-cols-[160px_1fr] items-baseline gap-4">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div>
        <div className="font-medium">{value}</div>
        <div className="text-xs text-muted-foreground">{hint}</div>
      </div>
    </div>
  );
}
