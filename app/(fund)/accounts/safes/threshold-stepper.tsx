// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { Minus, Plus } from "lucide-react";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

import { clampThreshold } from "./format";

// −/+ stepper for a Safe threshold, clamped to 1..total. Shows the result as
// a sentence ("2 of 3 signatures required") so nobody has to do the maths.
export function ThresholdStepper({
  id,
  value,
  total,
  onChange,
  disabled,
}: {
  id: string;
  value: number;
  total: number;
  onChange: (next: number) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("fund.safes");
  const max = Math.max(1, total);
  const current = clampThreshold(value, max);

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{t("thresholdLabel")}</Label>
      <div className="flex items-center gap-3">
        <div className="inline-flex items-center rounded-lg ring-1 ring-foreground/15">
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("thresholdDecrease")}
            onClick={() => onChange(clampThreshold(current - 1, max))}
            disabled={disabled || current <= 1}
          >
            <Minus />
          </Button>
          <output
            id={id}
            aria-live="polite"
            className="w-8 text-center text-sm font-medium tabular-nums"
          >
            {current}
          </output>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={t("thresholdIncrease")}
            onClick={() => onChange(clampThreshold(current + 1, max))}
            disabled={disabled || current >= max}
          >
            <Plus />
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          {t("thresholdRequired", { n: current, m: total })}
        </p>
      </div>
    </div>
  );
}
