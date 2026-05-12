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
  updateReferralSettingsAction,
  updateTokenSettingsAction,
} from "@/services/fund/settings-actions";

// Reusable form scaffold. Each tab passes its own fields + submit action;
// this handles the submit / error / pending plumbing identically.

type FieldType = "text" | "url" | "color" | "select" | "decimal";
type FieldSpec<T> = {
  key: keyof T;
  label: string;
  hint?: string;
  type?: FieldType;
  options?: { value: string; label: string }[];
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
  action: (data: T) => Promise<{ ok: true } | { error: string }>;
  saveLabel: string;
  savingLabel: string;
}) {
  const [values, setValues] = useState<T>(initial);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();
  const tSaved = useTranslations("fund.settings");

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await action(values);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setSaved(true);
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
            setValues((prev) => ({ ...prev, [f.key]: v }) as T);
          }}
        />
      ))}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
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
  defaultLocale: string;
  timezone: string;
  allocationMode: "FIXED_PERIOD" | "PAY_AND_GO";
  logoUrl: string | null;
  primaryColor: string | null;
  tokenName: string | null;
  tokenSymbol: string | null;
  termsUrl: string | null;
  privacyUrl: string | null;
  citizenPayFundId: string | null;
  referralBonusAmount: string | null;
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
        defaultLocale: fund.defaultLocale,
        timezone: fund.timezone,
        allocationMode: fund.allocationMode,
      }}
      action={async (v) =>
        updateGeneralSettingsAction({
          name: v.name,
          // Cast: the SettingsForm state holds `string`, but the action
          // validates locale via Zod refine. Same for allocationMode.
          defaultLocale: v.defaultLocale as "en" | "fr" | "nl",
          timezone: v.timezone,
          allocationMode: v.allocationMode as "FIXED_PERIOD" | "PAY_AND_GO",
        })
      }
      fields={[
        { key: "name", label: t("name"), hint: t("nameHint") },
        {
          key: "defaultLocale",
          label: t("language"),
          hint: t("languageHint"),
          type: "select",
          options: [
            { value: "fr", label: "Français" },
            { value: "en", label: "English" },
            { value: "nl", label: "Nederlands" },
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
          ],
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
      }}
      action={async (v) =>
        updateBrandingSettingsAction({
          logoUrl: v.logoUrl,
          primaryColor: v.primaryColor,
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
      ]}
    />
  );
}

export function TokenForm({ fund }: { fund: Fund }) {
  const t = useTranslations("fund.settings.token");
  const tRoot = useTranslations("fund.settings");
  return (
    <SettingsForm
      saveLabel={tRoot("save")}
      savingLabel={tRoot("saving")}
      initial={{
        tokenName: fund.tokenName ?? "",
        tokenSymbol: fund.tokenSymbol ?? "",
      }}
      action={async (v) =>
        updateTokenSettingsAction({
          tokenName: v.tokenName,
          tokenSymbol: v.tokenSymbol,
        })
      }
      fields={[
        { key: "tokenName", label: t("name"), hint: t("nameHint") },
        { key: "tokenSymbol", label: t("symbol"), hint: t("symbolHint") },
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
