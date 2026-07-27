// SPDX-License-Identifier: AGPL-3.0-or-later
import { Suspense } from "react";
import { getTranslations } from "next-intl/server";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, resolveActiveTab } from "@/components/ui/tabs";
import { prisma } from "@/services/db/prisma";
import { requireFundRole } from "@/services/auth/dal";
import { getFundUrl, requireCurrentFund } from "@/services/fund/server";
import {
  OnboardingFields,
  type FieldRow,
  type StepOption,
} from "./onboarding-fields";
import { OnboardingSettings } from "./onboarding-settings";
import { OnboardingSteps, type StepRow } from "./onboarding-steps";
import {
  SignupLinkReference,
  type PrefillParam,
} from "./signup-link-reference";
import { EmailsTab } from "./emails-tab";
import { DocumentsTab } from "./documents-tab";
import { CitizenPayConnect } from "./citizenpay-connect";
import { TokenInfo } from "./token-info";
import {
  BrandingForm,
  CitizenPayForm,
  FeeForm,
  GeneralForm,
  LegalForm,
  SignupRedirectsForm,
} from "./settings-forms";

const TABS = [
  { value: "general" },
  { value: "branding" },
  { value: "emails" },
  { value: "documents" },
  { value: "token" },
  { value: "onboarding" },
  { value: "terms" },
  { value: "citizenpay" },
  { value: "fees" },
] as const;

// ADMIN-only. The guard awaits at the top (the (fund) layout only requires
// OPERATOR), so the page suspends to the group skeleton until authorized
// rather than leaking any tab content to a non-admin.
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; connect?: string }>;
}) {
  await requireFundRole("ADMIN");
  return (
    <>
      <Suspense fallback={<SettingsHeaderSkeleton />}>
        <SettingsHeader />
      </Suspense>
      <Suspense fallback={<SettingsTabsSkeleton />}>
        <SettingsContent searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function SettingsHeader() {
  const t = await getTranslations("fund.settings");
  return (
    <header className="space-y-1">
      <h1 className="font-heading text-2xl font-medium">{t("title")}</h1>
      <p className="text-sm text-muted-foreground">{t("description")}</p>
    </header>
  );
}

function SettingsHeaderSkeleton() {
  return (
    <div className="space-y-1">
      <Skeleton className="h-7 w-40" />
      <Skeleton className="h-4 w-80 max-w-full" />
    </div>
  );
}

function SettingsTabsSkeleton() {
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {Array.from({ length: 9 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-20" />
        ))}
      </div>
      <Skeleton className="h-64 w-full" />
    </>
  );
}

async function SettingsContent({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; connect?: string }>;
}) {
  const t = await getTranslations("fund.settings");
  const fund = await requireCurrentFund();
  const sp = await searchParams;
  const active = resolveActiveTab(sp.tab, TABS);

  // Serialize Decimal → string so we can pass into a client component.
  const fundForForms = {
    name: fund.name,
    fullName: fund.fullName,
    defaultLocale: fund.defaultLocale,
    timezone: fund.timezone,
    allocationMode: fund.allocationMode,
    allocationCutoffDay: fund.allocationCutoffDay,
    logoUrl: fund.logoUrl,
    primaryColor: fund.primaryColor,
    websiteUrl: fund.websiteUrl,
    termsUrl: fund.termsUrl,
    privacyUrl: fund.privacyUrl,
    citizenPayFundId: fund.citizenPayFundId,
    referralBonusAmount: fund.referralBonusAmount?.toString() ?? null,
    payoutFeePercentage: fund.payoutFeePercentage?.toString() ?? null,
    payoutFeeSynced: fund.payoutFeeSynced,
    memberSignupSuccessUrl: fund.memberSignupSuccessUrl,
    merchantSignupSuccessUrl: fund.merchantSignupSuccessUrl,
    memberSignupCancelUrl: fund.memberSignupCancelUrl,
    memberSignupErrorUrl: fund.memberSignupErrorUrl,
  };

  return (
    <>
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

      {active === "emails" && (
        <EmailsTab
          fund={{
            id: fund.id,
            defaultLocale: fund.defaultLocale,
            senderEmail: fund.senderEmail,
          }}
          initialPaused={fund.confirmationEmailsPausedAt !== null}
        />
      )}

      {active === "documents" && (
        <DocumentsTab
          fund={{ id: fund.id, defaultLocale: fund.defaultLocale }}
        />
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
            <TokenInfo
              token={{
                address: fund.tokenAddress,
                chainId: fund.tokenChainId,
                decimals: fund.tokenDecimals,
                name: fund.tokenName,
                symbol: fund.tokenSymbol,
                logoUrl: fund.tokenLogoUrl,
              }}
              minter={{
                eoaAddress: fund.tokenMinterEoaAddress,
                smartAccountAddress: fund.tokenMinterSmartAccountAddress,
              }}
              connected={Boolean(
                fund.citizenPayFundId && fund.citizenPayApiKeyId,
              )}
            />
          </CardContent>
        </Card>
      )}

      {active === "onboarding" && (
        <Suspense fallback={<Skeleton className="h-64 w-full" />}>
          <OnboardingTab
            fundId={fund.id}
            fundDomain={fund.domain}
            requireMemberEmailVerification={fund.requireMemberEmailVerification}
            requireMerchantEmailVerification={
              fund.requireMerchantEmailVerification
            }
            fundForForms={fundForForms}
          />
        </Suspense>
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
          <CardContent className="space-y-6 pb-4">
            <CitizenPayForm fund={fundForForms} />
            <CitizenPayConnect
              status={{
                treasuryId: fund.citizenPayFundId,
                apiKeyId: fund.citizenPayApiKeyId,
                apiKeyUpdatedAt:
                  fund.citizenPayApiKeyUpdatedAt?.toISOString() ?? null,
                flash: sp.connect ?? null,
              }}
            />
          </CardContent>
        </Card>
      )}

      {active === "fees" && (
        <Card>
          <CardHeader>
            <CardTitle>{t("fees.title")}</CardTitle>
            <CardDescription>{t("fees.description")}</CardDescription>
          </CardHeader>
          <CardContent className="pb-4">
            <FeeForm fund={fundForForms} />
          </CardContent>
        </Card>
      )}
    </>
  );
}

async function OnboardingTab({
  fundId,
  fundDomain,
  requireMemberEmailVerification,
  requireMerchantEmailVerification,
  fundForForms,
}: {
  fundId: string;
  fundDomain: string;
  requireMemberEmailVerification: boolean;
  requireMerchantEmailVerification: boolean;
  fundForForms: React.ComponentProps<typeof SignupRedirectsForm>["fund"];
}) {
  const t = await getTranslations("fund.settings");
  const tSignup = await getTranslations("members.signup");

  const [allFields, allSteps] = await Promise.all([
    prisma.onboardingField.findMany({
      where: { fundId },
      orderBy: [{ archivedAt: "asc" }, { position: "asc" }],
    }),
    prisma.onboardingStep.findMany({
      where: { fundId },
      orderBy: [{ archivedAt: "asc" }, { position: "asc" }],
    }),
  ]);

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
          stepId: f.stepId,
          options: config?.options ?? [],
          archivedAt: f.archivedAt,
        };
      });

  const stepRowsFor = (target: "MEMBER" | "MERCHANT"): StepRow[] =>
    allSteps
      .filter((s) => s.target === target)
      .map((s) => ({
        id: s.id,
        title: s.title,
        description: s.description,
        position: s.position,
        archivedAt: s.archivedAt,
        fieldCount: allFields.filter(
          (f) => f.stepId === s.id && f.archivedAt === null,
        ).length,
      }));

  // Only active steps can be assigned — see StepOption.
  const stepOptionsFor = (target: "MEMBER" | "MERCHANT"): StepOption[] =>
    allSteps
      .filter((s) => s.target === target && s.archivedAt === null)
      .map((s) => ({ id: s.id, title: s.title }));

  // The prefill contract for the fund's own website: the built-in inputs
  // plus every active member field, addressed by its key.
  const prefillParams: PrefillParam[] = [
    { name: "firstName", label: tSignup("firstName"), format: null },
    { name: "lastName", label: tSignup("lastName"), format: null },
    { name: "email", label: tSignup("email"), format: null },
    ...allFields
      .filter((f) => f.target === "MEMBER" && f.archivedAt === null)
      .map((f) => ({
        name: f.key,
        label: f.label,
        format: formatHintFor(f.type, f.config),
      })),
  ];

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
          <CardTitle>{t("onboarding.integration.title")}</CardTitle>
          <CardDescription>
            {t("onboarding.integration.description")}
          </CardDescription>
        </CardHeader>
        <CardContent className="pb-4">
          <SignupLinkReference
            joinUrl={`${getFundUrl(fundDomain)}/join`}
            params={prefillParams}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("onboarding.stepsTitle")}</CardTitle>
          <CardDescription>{t("onboarding.stepsDescription")}</CardDescription>
        </CardHeader>
        {/* Member-only for now: the merchant form still renders as a single
            page, so a merchant steps manager here would be a control that
            silently does nothing. OnboardingStep carries `target` already, so
            wiring /join-merchant up later needs no schema change. */}
        <CardContent className="pb-4">
          <OnboardingSteps target="MEMBER" steps={stepRowsFor("MEMBER")} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>{t("onboarding.fieldsTitle")}</CardTitle>
          <CardDescription>{t("onboarding.fieldsDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-8 pb-4">
          <OnboardingFields
            target="MEMBER"
            fields={rowsFor("MEMBER")}
            steps={stepOptionsFor("MEMBER")}
          />
          <OnboardingFields
            target="MERCHANT"
            fields={rowsFor("MERCHANT")}
            steps={stepOptionsFor("MERCHANT")}
          />
        </CardContent>
      </Card>
    </div>
  );
}

// What values the param accepts, for the integration table. SELECT-likes list
// their option values since those are the only strings prefill will honour
// (see services/member/prefill.ts).
function formatHintFor(type: string, config: unknown): string | null {
  const options =
    (config as { options?: { value: string }[] } | null)?.options ?? [];
  switch (type) {
    case "SELECT":
      return options.map((o) => o.value).join(" | ") || null;
    case "MULTISELECT":
      return options.length
        ? `${options.map((o) => o.value).join(",")} (comma-separated)`
        : null;
    case "CHECKBOX":
      return "true | false";
    case "DATE":
      return "YYYY-MM-DD";
    case "NUMBER":
      return "123";
    default:
      return null;
  }
}
