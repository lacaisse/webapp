// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { updateOnboardingSettingsAction } from "@/services/fund/settings-actions";

type Toggle = "requireMemberEmailVerification" | "requireMerchantEmailVerification";

export function OnboardingSettings({
  initialRequireMemberEmailVerification,
  initialRequireMerchantEmailVerification,
}: {
  initialRequireMemberEmailVerification: boolean;
  initialRequireMerchantEmailVerification: boolean;
}) {
  const t = useTranslations("fund.settings.onboarding");
  const [requireMember, setRequireMember] = useState(
    initialRequireMemberEmailVerification,
  );
  const [requireMerchant, setRequireMerchant] = useState(
    initialRequireMerchantEmailVerification,
  );
  const [pending, startTransition] = useTransition();

  const onToggle = (key: Toggle, value: boolean) => {
    // Optimistic update — flip locally first, then send. Revert on error.
    if (key === "requireMemberEmailVerification") setRequireMember(value);
    else setRequireMerchant(value);

    startTransition(async () => {
      const result = await updateOnboardingSettingsAction({ [key]: value });
      if ("error" in result) {
        if (key === "requireMemberEmailVerification") setRequireMember(!value);
        else setRequireMerchant(!value);
      }
    });
  };

  return (
    <div className="space-y-3">
      <Row
        label={t("verifyMember.label")}
        description={t("verifyMember.description")}
        checked={requireMember}
        disabled={pending}
        onChange={(v) => onToggle("requireMemberEmailVerification", v)}
      />
      <Row
        label={t("verifyMerchant.label")}
        description={t("verifyMerchant.description")}
        checked={requireMerchant}
        disabled={pending}
        onChange={(v) => onToggle("requireMerchantEmailVerification", v)}
      />
    </div>
  );
}

function Row({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-card p-3 transition-colors hover:bg-muted/40">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 size-4 rounded border-input"
      />
      <div className="flex-1 space-y-0.5">
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-muted-foreground">{description}</div>
      </div>
    </label>
  );
}
