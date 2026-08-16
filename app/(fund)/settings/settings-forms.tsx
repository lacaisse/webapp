// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  updateBrandingSettingsAction,
  updateCitizenPaySettingsAction,
  updateGeneralSettingsAction,
  updateLegalSettingsAction,
  updatePayoutFeeAction,
  updateReferralSettingsAction,
  updateSignupRedirectsAction,
} from "@/services/fund/settings-actions";
import type { SupportedLocale } from "@/services/i18n/config";

// Reusable form scaffold. Each tab passes its own fields + submit action;
// this handles the submit / error / pending plumbing identically.

type FieldType = "text" | "url" | "color" | "select" | "decimal" | "number";
type FieldSpec<T> = {
  key: keyof T;
  label: string;
  hint?: string;
  type?: FieldType;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
};

function SettingsForm<T extends Record<string, string>>({
  fields,
  initial,
  action,
  saveLabel,
  savingLabel,
}: {
  fields: FieldSpec<T>[];
  initial: T;
  action: (
    data: T,
  ) => Promise<{ ok: true; warning?: string } | { error: string }>;
  saveLabel: string;
  savingLabel: string;
}) {
  const [values, setValues] = useState<T>(initial);
  const [error, setError] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();
  const tSaved = useTranslations("fund.settings");

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setWarning(null);
    setSaved(false);
    startTransition(async () => {
      const result = await action(values);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setSaved(true);
      setWarning("warning" in result ? (result.warning ?? null) : null);
    });
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {fields.map((f) => (
        <FieldRow
          key={String(f.key)}
          spec={f}
          value={values[f.key]}
          onChange={(v) => {
            setSaved(false);
            setWarning(null);
            setValues((prev) => ({ ...prev, [f.key]: v }) as T);
          }}
        />
      ))}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {warning && (
        <Alert variant="warning">
          <AlertDescription>{warning}</AlertDescription>
        </Alert>
      )}
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {saved && !pending ? tSaved("saved") : null}
        </div>
        <Button type="submit" disabled={pending}>
          {pending ? savingLabel : saveLabel}
        </Button>
      </div>
    </form>
  );
}

function FieldRow<T extends Record<string, string>>({
  spec,
  value,
  onChange,
}: {
  spec: FieldSpec<T>;
  value: string;
  onChange: (v: string) => void;
}) {
  const id = `settings-${String(spec.key)}`;
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{spec.label}</Label>
      {spec.type === "select" ? (
        <select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 w-full rounded-md bg-background px-2 text-sm ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {spec.options?.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      ) : spec.type === "color" ? (
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={value || "#000000"}
            onChange={(e) => onChange(e.target.value)}
            className="h-8 w-12 rounded border border-border"
          />
          <Input
            id={id}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="#1a73e8"
          />
        </div>
      ) : spec.type === "number" ? (
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={spec.min}
          max={spec.max}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="off"
        />
      ) : (
        <Input
          id={id}
          type={spec.type === "url" ? "url" : "text"}
          inputMode={spec.type === "decimal" ? "decimal" : undefined}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      )}
      {spec.hint && (
        <p className="text-xs text-muted-foreground">{spec.hint}</p>
      )}
    </div>
  );
}

// =============================================================================
// Per-tab forms
// =============================================================================

type Fund = {
  name: string;
  fullName: string | null;
  defaultLocale: string;
  timezone: string;
  allocationMode: "FIXED_PERIOD" | "PAY_AND_GO" | "DISABLED";
  allocationCutoffDay: number;
  logoUrl: string | null;
  primaryColor: string | null;
  websiteUrl: string | null;
  termsUrl: string | null;
  privacyUrl: string | null;
  citizenPayFundId: string | null;
  referralBonusAmount: string | null;
  payoutFeePercentage: string | null;
  payoutFeeSynced: boolean;
  feeCollectionFrequency: "PER_PAYMENT" | "MONTHLY";
  memberSignupSuccessUrl: string | null;
  merchantSignupSuccessUrl: string | null;
  memberSignupCancelUrl: string | null;
  memberSignupErrorUrl: string | null;
};

export function GeneralForm({ fund }: { fund: Fund }) {
  const t = useTranslations("fund.settings.general");
  const tRoot = useTranslations("fund.settings");
  return (
    <SettingsForm
      saveLabel={tRoot("save")}
      savingLabel={tRoot("saving")}
      initial={{
        name: fund.name,
        fullName: fund.fullName ?? "",
        defaultLocale: fund.defaultLocale,
        timezone: fund.timezone,
        allocationMode: fund.allocationMode,
        allocationCutoffDay: String(fund.allocationCutoffDay),
      }}
      action={async (v) =>
        updateGeneralSettingsAction({
          name: v.name,
          fullName: v.fullName,
          // The SettingsForm state holds plain `string`, but the action's
          // schema narrows these (locale via a type-guard refine, allocation
          // mode via a Zod enum, cutoff day via z.coerce.number), so cast /
          // coerce back at the call boundary.
          defaultLocale: v.defaultLocale as SupportedLocale,
          timezone: v.timezone,
          allocationMode: v.allocationMode as
            | "FIXED_PERIOD"
            | "PAY_AND_GO"
            | "DISABLED",
          allocationCutoffDay: Number(v.allocationCutoffDay),
        })
      }
      fields={[
        { key: "name", label: t("name"), hint: t("nameHint") },
        { key: "fullName", label: t("fullName"), hint: t("fullNameHint") },
        {
          key: "defaultLocale",
          label: t("language"),
          hint: t("languageHint"),
          type: "select",
          options: [
            { value: "fr", label: "Français" },
            { value: "en", label: "English" },
            { value: "nl", label: "Nederlands" },
            { value: "es", label: "Español" },
          ],
        },
        { key: "timezone", label: t("timezone"), hint: t("timezoneHint") },
        {
          key: "allocationMode",
          label: t("allocationMode"),
          hint: t("allocationModeHint"),
          type: "select",
          options: [
            { value: "FIXED_PERIOD", label: t("modeFixedPeriod") },
            { value: "PAY_AND_GO", label: t("modePayAndGo") },
            { value: "DISABLED", label: t("modeDisabled") },
          ],
        },
        {
          key: "allocationCutoffDay",
          label: t("allocationCutoffDay"),
          hint: t("allocationCutoffDayHint"),
          type: "number",
          min: 1,
          max: 31,
        },
      ]}
    />
  );
}

export function BrandingForm({ fund }: { fund: Fund }) {
  const t = useTranslations("fund.settings.branding");
  const tRoot = useTranslations("fund.settings");
  return (
    <SettingsForm
      saveLabel={tRoot("save")}
      savingLabel={tRoot("saving")}
      initial={{
        logoUrl: fund.logoUrl ?? "",
        primaryColor: fund.primaryColor ?? "",
        websiteUrl: fund.websiteUrl ?? "",
      }}
      action={async (v) =>
        updateBrandingSettingsAction({
          logoUrl: v.logoUrl,
          primaryColor: v.primaryColor,
          websiteUrl: v.websiteUrl,
        })
      }
      fields={[
        { key: "logoUrl", label: t("logo"), hint: t("logoHint"), type: "url" },
        {
          key: "primaryColor",
          label: t("primaryColor"),
          hint: t("primaryColorHint"),
          type: "color",
        },
        {
          key: "websiteUrl",
          label: t("website"),
          hint: t("websiteHint"),
          type: "url",
        },
      ]}
    />
  );
}

export function CitizenPayForm({ fund }: { fund: Fund }) {
  const t = useTranslations("fund.settings.citizenpay");
  const tRoot = useTranslations("fund.settings");
  return (
    <SettingsForm
      saveLabel={tRoot("save")}
      savingLabel={tRoot("saving")}
      initial={{ citizenPayFundId: fund.citizenPayFundId ?? "" }}
      action={async (v) =>
        updateCitizenPaySettingsAction({
          citizenPayFundId: v.citizenPayFundId,
        })
      }
      fields={[
        {
          key: "citizenPayFundId",
          label: t("account"),
          hint: t("accountHint"),
        },
      ]}
    />
  );
}

export function LegalForm({ fund }: { fund: Fund }) {
  const t = useTranslations("fund.settings.terms");
  const tRoot = useTranslations("fund.settings");
  return (
    <SettingsForm
      saveLabel={tRoot("save")}
      savingLabel={tRoot("saving")}
      initial={{
        termsUrl: fund.termsUrl ?? "",
        privacyUrl: fund.privacyUrl ?? "",
      }}
      action={async (v) =>
        updateLegalSettingsAction({
          termsUrl: v.termsUrl,
          privacyUrl: v.privacyUrl,
        })
      }
      fields={[
        { key: "termsUrl", label: t("tos"), hint: t("tosHint"), type: "url" },
        {
          key: "privacyUrl",
          label: t("privacy"),
          hint: t("privacyHint"),
          type: "url",
        },
      ]}
    />
  );
}

export function SignupRedirectsForm({ fund }: { fund: Fund }) {
  const t = useTranslations("fund.settings.onboarding.redirects");
  const tRoot = useTranslations("fund.settings");
  return (
    <SettingsForm
      saveLabel={tRoot("save")}
      savingLabel={tRoot("saving")}
      initial={{
        memberSignupSuccessUrl: fund.memberSignupSuccessUrl ?? "",
        merchantSignupSuccessUrl: fund.merchantSignupSuccessUrl ?? "",
        memberSignupCancelUrl: fund.memberSignupCancelUrl ?? "",
        memberSignupErrorUrl: fund.memberSignupErrorUrl ?? "",
      }}
      action={async (v) =>
        updateSignupRedirectsAction({
          memberSignupSuccessUrl: v.memberSignupSuccessUrl,
          merchantSignupSuccessUrl: v.merchantSignupSuccessUrl,
          memberSignupCancelUrl: v.memberSignupCancelUrl,
          memberSignupErrorUrl: v.memberSignupErrorUrl,
        })
      }
      fields={[
        {
          key: "memberSignupSuccessUrl",
          label: t("member"),
          hint: t("memberHint"),
          type: "url",
        },
        {
          key: "memberSignupCancelUrl",
          label: t("memberCancel"),
          hint: t("memberCancelHint"),
          type: "url",
        },
        {
          key: "memberSignupErrorUrl",
          label: t("memberError"),
          hint: t("memberErrorHint"),
          type: "url",
        },
        {
          key: "merchantSignupSuccessUrl",
          label: t("merchant"),
          hint: t("merchantHint"),
          type: "url",
        },
      ]}
    />
  );
}

export function FeeForm({ fund }: { fund: Fund }) {
  const t = useTranslations("fund.settings.fees");
  const tRoot = useTranslations("fund.settings");
  // DB may lead CP: if a value is set but hasn't been accepted by CP yet,
  // tell the admin it isn't live — saving again retries the push.
  const showSyncPending = Boolean(fund.payoutFeePercentage) && !fund.payoutFeeSynced;
  return (
    <div className="space-y-4">
      {showSyncPending && (
        <Alert variant="warning">
          <AlertDescription>{t("syncPending")}</AlertDescription>
        </Alert>
      )}
      <SettingsForm
        saveLabel={tRoot("save")}
        savingLabel={tRoot("saving")}
        initial={{
          payoutFeePercentage: fund.payoutFeePercentage ?? "",
          feeCollectionFrequency: fund.feeCollectionFrequency,
        }}
        action={async (v) =>
          updatePayoutFeeAction({
            payoutFeePercentage: v.payoutFeePercentage,
            // The SettingsForm state holds plain `string`; the action's
            // schema narrows this to the FeeCollectionFrequency enum, so
            // cast back at the call boundary.
            feeCollectionFrequency: v.feeCollectionFrequency as
              | "PER_PAYMENT"
              | "MONTHLY",
          })
        }
        fields={[
          {
            key: "payoutFeePercentage",
            label: t("rate"),
            hint: t("rateHint"),
            type: "decimal",
          },
          {
            key: "feeCollectionFrequency",
            label: t("frequency"),
            hint: t("frequencyHint"),
            type: "select",
            options: [
              { value: "PER_PAYMENT", label: t("frequencyPerPayment") },
              { value: "MONTHLY", label: t("frequencyMonthly") },
            ],
          },
        ]}
      />
    </div>
  );
}

export function ReferralForm({ fund }: { fund: Fund }) {
  const t = useTranslations("fund.referrals.config");
  const tRoot = useTranslations("fund.settings");
  return (
    <SettingsForm
      saveLabel={tRoot("save")}
      savingLabel={tRoot("saving")}
      initial={{ referralBonusAmount: fund.referralBonusAmount ?? "" }}
      action={async (v) =>
        updateReferralSettingsAction({
          referralBonusAmount: v.referralBonusAmount,
        })
      }
      fields={[
        {
          key: "referralBonusAmount",
          label: t("bonus"),
          hint: t("bonusHint"),
          type: "decimal",
        },
      ]}
    />
  );
}
