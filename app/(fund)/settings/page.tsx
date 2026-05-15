// SPDX-License-Identifier: AGPL-3.0-or-later
import { getTranslations } from "next-intl/server";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, resolveActiveTab } from "@/components/ui/tabs";
import { prisma } from "@/services/db/prisma";
import { requireCurrentFund } from "@/services/fund/server";
import {
  OnboardingFields,
  type FieldRow,
} from "./onboarding-fields";
import { OnboardingSettings } from "./onboarding-settings";
import {
  BrandingForm,
  CitizenPayForm,
  GeneralForm,
  LegalForm,
  SignupRedirectsForm,
  TokenForm,
} from "./settings-forms";

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
  const fund = await requireCurrentFund();
  const sp = await searchParams;
  const active = resolveActiveTab(sp.tab, TABS);

  // Serialize Decimal → string so we can pass into a client component.
  const fundForForms = {
    name: fund.name,
    defaultLocale: fund.defaultLocale,
    timezone: fund.timezone,
    allocationMode: fund.allocationMode,
    logoUrl: fund.logoUrl,
    primaryColor: fund.primaryColor,
    tokenName: fund.tokenName,
    tokenSymbol: fund.tokenSymbol,
    termsUrl: fund.termsUrl,
    privacyUrl: fund.privacyUrl,
    citizenPayFundId: fund.citizenPayFundId,
    referralBonusAmount: fund.referralBonusAmount?.toString() ?? null,
    memberSignupSuccessUrl: fund.memberSignupSuccessUrl,
    merchantSignupSuccessUrl: fund.merchantSignupSuccessUrl,
  };

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
        <Card>
          <CardHeader>
            <CardTitle>{t("general.title")}</CardTitle>
            <CardDescription>{t("general.description")}</CardDescription>
          </CardHeader>
          <CardContent className="pb-4">
            <GeneralForm fund={fundForForms} />
          </CardContent>
        </Card>
      )}

      {active === "branding" && (
        <Card>
          <CardHeader>
            <CardTitle>{t("branding.title")}</CardTitle>
            <CardDescription>{t("branding.description")}</CardDescription>
          </CardHeader>
          <CardContent className="pb-4">
            <BrandingForm fund={fundForForms} />
          </CardContent>
        </Card>
      )}

      {active === "token" && (
        <Card>
          <CardHeader>
            <CardTitle>{t("token.title")}</CardTitle>
            <CardDescription>{t("token.description")}</CardDescription>
          </CardHeader>
          <CardContent className="pb-4">
            <TokenForm fund={fundForForms} />
          </CardContent>
        </Card>
      )}

      {active === "onboarding" && (
        <OnboardingTab
          fundId={fund.id}
          requireMemberEmailVerification={fund.requireMemberEmailVerification}
          requireMerchantEmailVerification={
            fund.requireMerchantEmailVerification
          }
          fundForForms={fundForForms}
        />
      )}

      {active === "terms" && (
        <Card>
          <CardHeader>
            <CardTitle>{t("terms.title")}</CardTitle>
            <CardDescription>{t("terms.description")}</CardDescription>
          </CardHeader>
          <CardContent className="pb-4">
            <LegalForm fund={fundForForms} />
          </CardContent>
        </Card>
      )}

      {active === "citizenpay" && (
        <Card>
          <CardHeader>
            <CardTitle>{t("citizenpay.title")}</CardTitle>
            <CardDescription>{t("citizenpay.description")}</CardDescription>
          </CardHeader>
          <CardContent className="pb-4">
            <CitizenPayForm fund={fundForForms} />
          </CardContent>
        </Card>
      )}
    </>
  );
}

async function OnboardingTab({
  fundId,
  requireMemberEmailVerification,
  requireMerchantEmailVerification,
  fundForForms,
}: {
  fundId: string;
  requireMemberEmailVerification: boolean;
  requireMerchantEmailVerification: boolean;
  fundForForms: React.ComponentProps<typeof SignupRedirectsForm>["fund"];
}) {
  const t = await getTranslations("fund.settings");

  const allFields = await prisma.onboardingField.findMany({
    where: { fundId },
    orderBy: [{ archivedAt: "asc" }, { position: "asc" }],
  });

  const rowsFor = (target: "MEMBER" | "MERCHANT"): FieldRow[] =>
    allFields
      .filter((f) => f.target === target)
      .map((f) => {
        const config = (f.config as { options?: FieldRow["options"] } | null) ??
          null;
        return {
          id: f.id,
          key: f.key,
          type: f.type,
          label: f.label,
          helpText: f.helpText,
          required: f.required,
          position: f.position,
          options: config?.options ?? [],
          archivedAt: f.archivedAt,
        };
      });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("onboarding.title")}</CardTitle>
          <CardDescription>{t("onboarding.description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6 pb-4">
          <OnboardingSettings
            initialRequireMemberEmailVerification={
              requireMemberEmailVerification
            }
            initialRequireMerchantEmailVerification={
              requireMerchantEmailVerification
            }
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("onboarding.redirects.title")}</CardTitle>
          <CardDescription>
            {t("onboarding.redirects.description")}
          </CardDescription>
        </CardHeader>
        <CardContent className="pb-4">
          <SignupRedirectsForm fund={fundForForms} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("onboarding.fieldsTitle")}</CardTitle>
          <CardDescription>{t("onboarding.fieldsDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-8 pb-4">
          <OnboardingFields target="MEMBER" fields={rowsFor("MEMBER")} />
          <OnboardingFields target="MERCHANT" fields={rowsFor("MERCHANT")} />
        </CardContent>
      </Card>
    </div>
  );
}
