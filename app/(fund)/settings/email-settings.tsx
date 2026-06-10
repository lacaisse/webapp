// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { setConfirmationEmailsPausedAction } from "@/services/fund/settings-actions";

// Pause switch for member-facing confirmation emails (deposit recorded /
// tokens allocated). Optimistic toggle, same pattern as OnboardingSettings.
export function EmailSettings({
  initialPaused,
}: {
  initialPaused: boolean;
}) {
  const t = useTranslations("fund.settings.emails");
  const [paused, setPaused] = useState(initialPaused);
  const [pending, startTransition] = useTransition();

  const onToggle = (value: boolean) => {
    setPaused(value);
    startTransition(async () => {
      const result = await setConfirmationEmailsPausedAction({
        paused: value,
      });
      if ("error" in result) setPaused(!value);
    });
  };

  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-card p-3 transition-colors hover:bg-muted/40">
      <input
        type="checkbox"
        checked={paused}
        disabled={pending}
        onChange={(e) => onToggle(e.target.checked)}
        className="mt-1 size-4 rounded border-input"
      />
      <div className="flex-1 space-y-0.5">
        <div className="text-sm font-medium">{t("pause.label")}</div>
        <div className="text-xs text-muted-foreground">
          {t("pause.description")}
        </div>
      </div>
    </label>
  );
}
