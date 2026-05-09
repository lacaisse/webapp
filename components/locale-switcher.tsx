"use client";

import { useLocale, useTranslations } from "next-intl";
import { useTransition } from "react";
import { SUPPORTED_LOCALES, type SupportedLocale } from "@/services/i18n/config";
import { setLocale } from "@/services/i18n/locale";

export function LocaleSwitcher() {
  const locale = useLocale();
  const t = useTranslations("locale");
  const [pending, startTransition] = useTransition();

  return (
    <div className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      {SUPPORTED_LOCALES.map((loc, i) => (
        <span key={loc} className="inline-flex items-center gap-1">
          {i > 0 && <span aria-hidden>·</span>}
          <button
            type="button"
            disabled={pending || locale === loc}
            onClick={() => startTransition(() => setLocale(loc))}
            className={
              locale === loc
                ? "font-medium text-foreground"
                : "hover:text-foreground transition-colors"
            }
          >
            {t(loc as SupportedLocale)}
          </button>
        </span>
      ))}
    </div>
  );
}
