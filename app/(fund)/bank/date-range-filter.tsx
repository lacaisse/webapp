// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RANGE_PRESETS, type RangePreset } from "./range";

// URL-driven date-range filter for the transactions table. Each preset writes
// `?range=…` (and clears `?from`/`?to` unless custom); the custom inputs write
// `?from`/`?to` as `YYYY-MM-DD`. Changing the filter always resets `?page` to 1.
export function DateRangeFilter({
  range,
  from,
  to,
}: {
  range: RangePreset;
  from: string;
  to: string;
}) {
  const t = useTranslations("fund.bank.range");
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  function navigate(params: URLSearchParams) {
    params.delete("page");
    const qs = params.toString();
    startTransition(() => router.replace(qs ? `?${qs}` : "?", { scroll: false }));
  }

  function selectPreset(preset: RangePreset) {
    const params = new URLSearchParams(searchParams);
    params.set("range", preset);
    if (preset !== "custom") {
      params.delete("from");
      params.delete("to");
    }
    navigate(params);
  }

  function setCustomDay(key: "from" | "to", value: string) {
    const params = new URLSearchParams(searchParams);
    params.set("range", "custom");
    if (value) params.set(key, value);
    else params.delete(key);
    navigate(params);
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex flex-wrap gap-1.5">
        {RANGE_PRESETS.map((preset) => (
          <Button
            key={preset}
            type="button"
            size="sm"
            variant={range === preset ? "default" : "outline"}
            disabled={pending}
            onClick={() => selectPreset(preset)}
          >
            {t(preset)}
          </Button>
        ))}
      </div>

      {range === "custom" && (
        <div className="flex items-end gap-2">
          <div className="space-y-1">
            <Label htmlFor="bank-from" className="text-xs">
              {t("from")}
            </Label>
            <Input
              id="bank-from"
              type="date"
              value={from}
              max={to || undefined}
              disabled={pending}
              onChange={(e) => setCustomDay("from", e.target.value)}
              className="h-8 w-auto"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="bank-to" className="text-xs">
              {t("to")}
            </Label>
            <Input
              id="bank-to"
              type="date"
              value={to}
              min={from || undefined}
              disabled={pending}
              onChange={(e) => setCustomDay("to", e.target.value)}
              className="h-8 w-auto"
            />
          </div>
        </div>
      )}
    </div>
  );
}
