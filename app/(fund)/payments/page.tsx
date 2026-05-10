import { getTranslations } from "next-intl/server";

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
  { value: "transactions" },
  { value: "payouts" },
  { value: "fees" },
  { value: "byMerchant" },
] as const;

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const t = await getTranslations("fund.payments");
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

      {active === "transactions" && <TransactionsTab />}
      {active === "payouts" && <PayoutsTab />}
      {active === "fees" && <FeesTab />}
      {active === "byMerchant" && <ByMerchantTab />}
    </>
  );
}

async function TransactionsTab() {
  const t = await getTranslations("fund.payments.transactions");
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("date")}</TableHead>
          <TableHead>{t("member")}</TableHead>
          <TableHead>{t("merchant")}</TableHead>
          <TableHead>{t("amount")}</TableHead>
          <TableHead>{t("tokens")}</TableHead>
          <TableHead>{t("status")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableEmpty colSpan={6}>{t("empty")}</TableEmpty>
      </TableBody>
    </Table>
  );
}

async function PayoutsTab() {
  const t = await getTranslations("fund.payments.payouts");
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("date")}</TableHead>
          <TableHead>{t("merchant")}</TableHead>
          <TableHead>{t("transactions")}</TableHead>
          <TableHead>{t("gross")}</TableHead>
          <TableHead>{t("fees")}</TableHead>
          <TableHead>{t("net")}</TableHead>
          <TableHead>{t("status")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableEmpty colSpan={7}>{t("empty")}</TableEmpty>
      </TableBody>
    </Table>
  );
}

async function FeesTab() {
  const t = await getTranslations("fund.payments.fees");
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("date")}</TableHead>
          <TableHead>{t("merchant")}</TableHead>
          <TableHead>{t("transaction")}</TableHead>
          <TableHead>{t("rate")}</TableHead>
          <TableHead>{t("amount")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableEmpty colSpan={5}>{t("empty")}</TableEmpty>
      </TableBody>
    </Table>
  );
}

async function ByMerchantTab() {
  const t = await getTranslations("fund.payments.byMerchant");
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("merchant")}</TableHead>
          <TableHead>{t("transactions")}</TableHead>
          <TableHead>{t("totalGross")}</TableHead>
          <TableHead>{t("totalFees")}</TableHead>
          <TableHead>{t("totalPaidOut")}</TableHead>
          <TableHead>{t("balance")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableEmpty colSpan={6}>{t("empty")}</TableEmpty>
      </TableBody>
    </Table>
  );
}
