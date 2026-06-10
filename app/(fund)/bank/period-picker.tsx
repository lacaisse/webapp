// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";

import { setBankTransactionPeriodAction } from "@/services/bank-sync/admin-actions";

import type { AssignablePeriod } from "./data";

// Inline period assignment for an INCOMING deposit on the Bank page. Empty
// option = no period. Data-only — assigning never mints or emails; minting
// happens at period close (or manually). Rows already used as a mint source
// don't render this picker (see transactions-table).
export function BankTxPeriodPicker({
  bankTransactionId,
  currentPeriodId,
  periods,
}: {
  bankTransactionId: string;
  currentPeriodId: string | null;
  periods: AssignablePeriod[];
}) {
  const t = useTranslations("fund.bank.periodAssign");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onChange = (value: string) => {
    setError(null);
    startTransition(async () => {
      const result = await setBankTransactionPeriodAction({
        bankTransactionId,
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
            {p.status === "OPEN" ? p.label : t("closedOption", { label: p.label })}
          </option>
        ))}
      </select>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
