// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { Loader2 } from "lucide-react";
import { useFormatter, useLocale, useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import {
  formatEuroInput,
  MAX_WEEKLY_LIMIT_CENTS,
  parseEuroInput,
} from "@/lib/weekly-limit";
import { setCardSourceLimitAction } from "@/services/card/admin-actions";

// Weekly cap on what a card pulls from its source, typed in euros and stored
// on CitizenPay in cents. Saved on blur / Enter; blank clears the cap. The
// page reads the value (and this week's usage) back live on re-render — the
// parent keys this component on the saved value so a server change resets it.
export function CardWeeklyLimitInput({
  cardId,
  limitCents,
  hasSource,
}: {
  cardId: string;
  limitCents: number | null;
  // A cap without a source caps nothing — the input is disabled until one is set.
  hasSource: boolean;
}) {
  const t = useTranslations("fund.cards.detail.source.weeklyLimit");
  const format = useFormatter();
  const sep = useLocale() === "en" ? "." : ",";
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<number | null>(limitCents);
  const [text, setText] = useState(() => formatEuroInput(limitCents, sep));

  const commit = () => {
    const parsed = parseEuroInput(text);
    if (!parsed.ok) {
      setError(
        t(`errors.${parsed.error}`, {
          max: format.number(MAX_WEEKLY_LIMIT_CENTS / 100, {
            style: "currency",
            currency: "EUR",
          }),
        }),
      );
      return;
    }
    // 0 and blank both mean "no cap" on CitizenPay.
    const next = parsed.cents || null;
    setError(null);
    setText(formatEuroInput(next, sep));
    if (next === saved) return;

    const prev = saved;
    setSaved(next);
    startTransition(async () => {
      const result = await setCardSourceLimitAction({ cardId, limitCents: next });
      if ("error" in result) {
        setError(result.error);
        setSaved(prev);
        setText(formatEuroInput(prev, sep));
      }
    });
  };

  return (
    <div className="space-y-1">
      <div className="relative max-w-40">
        <span className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-xs text-muted-foreground">
          €
        </span>
        <input
          type="text"
          inputMode="decimal"
          autoComplete="off"
          aria-label={t("label")}
          aria-invalid={error ? true : undefined}
          placeholder={t("placeholder")}
          value={text}
          disabled={pending || !hasSource}
          onChange={(e) => {
            setText(e.target.value);
            if (error) setError(null);
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              setText(formatEuroInput(saved, sep));
              setError(null);
            }
          }}
          className="h-8 w-full rounded-md bg-background py-1 pr-7 pl-5 text-xs tabular-nums ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 aria-invalid:ring-destructive"
        />
        {pending && (
          <div className="absolute inset-y-0 right-2 flex items-center text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
          </div>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {hasSource ? t("hint") : t("noSource")}
      </p>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
