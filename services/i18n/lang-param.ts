// SPDX-License-Identifier: AGPL-3.0-or-later
// Plain module (no `next/*`, no DB) so the decision is unit-testable and safe
// to import from proxy.ts.
//
// `?lang=<locale>` lets another origin pick our language for a visitor. The
// Citizen Pay card wallet (tap.citizenpay.eu) links its "Add funds" button to
// `https://<fund>/pay/<serial>?lang=fr`: the wallet's own `locale` cookie
// never crosses origins, so without this a holder who chose French there
// would land here in their phone's language.
//
// proxy.ts turns the parameter into the `locale` cookie and redirects to the
// same URL without it — a one-shot, persistent choice — rather than reading
// the query at render time. If the URL kept `?lang=fr` and the query won over
// the cookie, the in-page LocaleSwitcher (which sets the cookie and
// revalidates the SAME URL) would appear broken: the page would snap back to
// French. Once the parameter is gone, the cookie is the single source of
// truth again, so the bank's return page and the switcher both behave.

import { isSupportedLocale, type SupportedLocale } from "./config";

export const LANG_PARAM = "lang";

// Must match what `setLocale` in ./locale.ts writes (that file is
// "use server" and can only export async functions, so it can't share these).
export const LOCALE_COOKIE = "locale";
export const LOCALE_COOKIE_OPTIONS = {
  path: "/",
  maxAge: 60 * 60 * 24 * 365,
  sameSite: "lax",
} as const;

/**
 * If `url` carries a supported `?lang=`, return the locale to persist and the
 * same URL with only `lang` removed (path and every other parameter kept).
 * Matching is case-insensitive (`FR` → `fr`). Returns null when there is no
 * `lang` or its value isn't a supported locale — the request then proceeds
 * untouched.
 */
export function langParamRedirect(
  url: URL,
): { locale: SupportedLocale; target: URL } | null {
  const raw = url.searchParams.get(LANG_PARAM);
  if (raw === null) return null;
  const locale = raw.trim().toLowerCase();
  if (!isSupportedLocale(locale)) return null;

  const target = new URL(url.href);
  target.searchParams.delete(LANG_PARAM);
  return { locale, target };
}
