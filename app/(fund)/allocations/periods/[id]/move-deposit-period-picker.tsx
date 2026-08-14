// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";

import { setBankTransactionPeriodAction } from "@/services/bank-sync/admin-actions";

import type { AssignablePeriod } from "@/app/(fund)/bank/data";

// Reassign an unallocated deposit to a different allocation period, including
// closed ones — a late payment attributed to a closed period can still be
// allocated manually afterwards (see services/allocation-periods/run.ts). The
// deposits tab only renders this for rows with no operationSources; once a
// deposit fed a mint, setBankTransactionPeriodAction refuses to move it.
export function MoveDepositPeriodPicker({
  bankTransactionId,
  currentPeriodId,
  periods,
}: {
  bankTransactionId: string;
  currentPeriodId: string;
  periods: AssignablePeriod[];
}) {
  const t = useTranslations("fund.allocations.periodDetail.movePeriod");
  const tAssign = useTranslations("fund.bank.periodAssign");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const options = periods.filter((p) => p.id !== currentPeriodId);
  if (options.length === 0) return null;

  const onChange = (value: string) => {
    if (!value) return;
    setError(null);
    startTransition(async () => {
      const result = await setBankTransactionPeriodAction({
        bankTransactionId,
        periodId: value,
      });
      if ("error" in result) setError(result.error);
    });
  };

  return (
    <div className="space-y-0.5">
      <select
        defaultValue=""
        onChange={(e) => onChange(e.target.value)}
        disabled={pending}
        className="h-7 rounded-md bg-background px-2 text-xs ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <option value="" disabled>
          {t("placeholder")}
        </option>
        {options.map((p) => (
          <option key={p.id} value={p.id}>
            {p.status === "OPEN"
              ? p.label
              : tAssign("closedOption", { label: p.label })}
          </option>
        ))}
      </select>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
