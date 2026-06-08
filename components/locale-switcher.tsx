// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { Languages } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useTransition } from "react";
import { SUPPORTED_LOCALES, type SupportedLocale } from "@/services/i18n/config";
import { setLocale } from "@/services/i18n/locale";

// A compact native <select> picker (rather than an inline button row) so it
// stays single-line in the narrow fund sidebar no matter how many locales we
// support. Matches the native-select pattern used by the settings forms.
export function LocaleSwitcher() {
  const locale = useLocale();
  const t = useTranslations("locale");
  const [pending, startTransition] = useTransition();

  return (
    <label className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <Languages className="size-3.5 shrink-0" aria-hidden />
      <span className="sr-only">{t("label")}</span>
      <select
        aria-label={t("label")}
        value={locale}
        disabled={pending}
        onChange={(e) =>
          startTransition(() => setLocale(e.target.value as SupportedLocale))
        }
        className="rounded-md bg-transparent py-0.5 pr-1 text-xs outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        {SUPPORTED_LOCALES.map((loc) => (
          <option key={loc} value={loc}>
            {t(loc as SupportedLocale)}
          </option>
        ))}
      </select>
    </label>
  );
}
