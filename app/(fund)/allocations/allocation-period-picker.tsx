// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { setTokenOperationPeriodAction } from "@/services/allocation-periods/manual-allocation-actions";

import type { AssignablePeriod } from "@/app/(fund)/bank/data";

// Inline period assignment for a manual allocation on the History tab. Empty
// option = no period. Data-only — the mint already happened; this just tags it
// to a period so it counts there. Only rendered for manual allocations (ops
// not linked to a deposit) in FIXED_PERIOD funds.
export function AllocationPeriodPicker({
  tokenOperationId,
  currentPeriodId,
  periods,
}: {
  tokenOperationId: string;
  currentPeriodId: string | null;
  periods: AssignablePeriod[];
}) {
  const t = useTranslations("fund.allocations.reconcile");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onChange = (value: string) => {
    setError(null);
    startTransition(async () => {
      const result = await setTokenOperationPeriodAction({
        tokenOperationId,
        periodId: value === "" ? null : value,
      });
      if ("error" in result) setError(result.error);
    });
  };

  return (
    <div className="space-y-0.5">
      <select
        defaultValue={currentPeriodId ?? ""}
        onChange={(e) => onChange(e.target.value)}
        disabled={pending}
        className="h-7 rounded-md bg-background px-2 text-xs ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <option value="">{t("none")}</option>
        {periods.map((p) => (
          <option key={p.id} value={p.id}>
            {p.status === "OPEN"
              ? p.label
              : t("closedOption", { label: p.label })}
          </option>
        ))}
      </select>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
