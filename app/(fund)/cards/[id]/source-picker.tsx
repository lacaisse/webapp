// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";

import { setCardSourceAction } from "@/services/card/admin-actions";

export type SourceCardOption = {
  id: string;
  label: string;
};

// Inline picker for the card's source card (the card it pulls from when its
// own balance can't cover a charge). Empty option = no source. The
// relationship lives on CitizenPay; the page reads it back on re-render.
export function CardSourcePicker({
  cardId,
  currentSourceCardId,
  // Set when CP reports a source serial we couldn't resolve to a local card
  // (e.g. deleted locally) — shown as-is so the admin sees it's configured.
  unresolvedSourceSerial,
  options,
}: {
  cardId: string;
  currentSourceCardId: string | null;
  unresolvedSourceSerial: string | null;
  options: SourceCardOption[];
}) {
  const t = useTranslations("fund.cards.detail.source");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const UNRESOLVED = "__unresolved__";
  const onChange = (value: string) => {
    if (value === UNRESOLVED) return;
    setError(null);
    startTransition(async () => {
      const result = await setCardSourceAction({
        cardId,
        sourceCardId: value === "" ? null : value,
      });
      if ("error" in result) setError(result.error);
    });
  };

  return (
    <div className="space-y-1">
      <select
        defaultValue={
          unresolvedSourceSerial ? UNRESOLVED : (currentSourceCardId ?? "")
        }
        onChange={(e) => onChange(e.target.value)}
        disabled={pending}
        className="h-7 max-w-full rounded-md bg-background px-2 text-xs ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <option value="">{t("none")}</option>
        {unresolvedSourceSerial && (
          <option value={UNRESOLVED}>{unresolvedSourceSerial}</option>
        )}
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      <p className="text-xs text-muted-foreground">{t("hint")}</p>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
