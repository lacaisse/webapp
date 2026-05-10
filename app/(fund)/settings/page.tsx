import { getTranslations } from "next-intl/server";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, resolveActiveTab } from "@/components/ui/tabs";

const TABS = [
  { value: "general" },
  { value: "branding" },
  { value: "token" },
  { value: "onboarding" },
  { value: "terms" },
  { value: "citizenpay" },
] as const;

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const t = await getTranslations("fund.settings");
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

      {active === "general" && (
        <SettingsCard
          title={t("general.title")}
          description={t("general.description")}
          fields={[
            { label: t("general.name"), hint: t("general.nameHint") },
            { label: t("general.domain"), hint: t("general.domainHint") },
            { label: t("general.language"), hint: t("general.languageHint") },
            { label: t("general.timezone"), hint: t("general.timezoneHint") },
          ]}
        />
      )}

      {active === "branding" && (
        <SettingsCard
          title={t("branding.title")}
          description={t("branding.description")}
          fields={[
            { label: t("branding.logo"), hint: t("branding.logoHint") },
            { label: t("branding.primaryColor"), hint: t("branding.primaryColorHint") },
            { label: t("branding.favicon"), hint: t("branding.faviconHint") },
          ]}
        />
      )}

      {active === "token" && (
        <SettingsCard
          title={t("token.title")}
          description={t("token.description")}
          fields={[
            { label: t("token.name"), hint: t("token.nameHint") },
            { label: t("token.symbol"), hint: t("token.symbolHint") },
            { label: t("token.cap"), hint: t("token.capHint") },
          ]}
        />
      )}

      {active === "onboarding" && (
        <SettingsCard
          title={t("onboarding.title")}
          description={t("onboarding.description")}
          fields={[
            { label: t("onboarding.fields"), hint: t("onboarding.fieldsHint") },
            { label: t("onboarding.cardOptions"), hint: t("onboarding.cardOptionsHint") },
            { label: t("onboarding.welcomeMessage"), hint: t("onboarding.welcomeMessageHint") },
          ]}
        />
      )}

      {active === "terms" && (
        <SettingsCard
          title={t("terms.title")}
          description={t("terms.description")}
          fields={[
            { label: t("terms.tos"), hint: t("terms.tosHint") },
            { label: t("terms.privacy"), hint: t("terms.privacyHint") },
          ]}
        />
      )}

      {active === "citizenpay" && (
        <Card>
          <CardHeader>
            <CardTitle>{t("citizenpay.title")}</CardTitle>
            <CardDescription>{t("citizenpay.description")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 pb-4 text-sm">
            <Field label={t("citizenpay.account")} value="—" hint={t("citizenpay.accountHint")} />
            <Field label={t("citizenpay.terminal")} value="—" hint={t("citizenpay.terminalHint")} />
            <Field label={t("citizenpay.connection")} value="—" hint={t("citizenpay.connectionHint")} />
            <Field label={t("citizenpay.lastSync")} value="—" hint={t("citizenpay.lastSyncHint")} />
          </CardContent>
        </Card>
      )}
    </>
  );
}

function SettingsCard({
  title,
  description,
  fields,
}: {
  title: string;
  description: string;
  fields: { label: string; hint: string }[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pb-4 text-sm">
        {fields.map((f) => (
          <Field key={f.label} label={f.label} value="—" hint={f.hint} />
        ))}
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
    <div className="grid grid-cols-[180px_1fr] items-baseline gap-4">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div>
        <div className="font-medium">{value}</div>
        <div className="text-xs text-muted-foreground">{hint}</div>
      </div>
    </div>
  );
}
