// Plain module — safe to import from client and server. The list of locales
// must NOT live in `locale.ts` (that file is `"use server"` and may only
// export async functions; exporting constants from it produces a runtime
// server-reference proxy, not the array).

export const SUPPORTED_LOCALES = ["en", "fr", "nl"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

// English is the fallback when the user's browser locale doesn't match any
// supported one. The user's explicit choice (cookie) always wins over this.
export const DEFAULT_LOCALE: SupportedLocale = "en";

export function isSupportedLocale(value: string): value is SupportedLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * Pick the best supported locale for an `Accept-Language` header value.
 * Walks the user's preferences in order and returns the first one whose
 * primary subtag (e.g. `fr` from `fr-CA`) we support. Falls back to
 * `DEFAULT_LOCALE` if nothing matches.
 *
 * Note: we ignore `q=` weights — for a 3-locale set this is fine; if we
 * ever need fancier negotiation, swap in `@formatjs/intl-localematcher`.
 */
export function negotiateLocale(
  acceptLanguage: string | null | undefined,
): SupportedLocale {
  if (!acceptLanguage) return DEFAULT_LOCALE;
  const tags = acceptLanguage
    .split(",")
    .map((entry) => entry.split(";")[0]?.trim().toLowerCase())
    .filter(Boolean)
    .map((tag) => tag.split("-")[0]);
  for (const tag of tags) {
    if (isSupportedLocale(tag)) return tag;
  }
  return DEFAULT_LOCALE;
}
