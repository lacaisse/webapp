// SPDX-License-Identifier: AGPL-3.0-or-later
import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import {
  DEFAULT_LOCALE,
  isSupportedLocale,
  negotiateLocale,
} from "@/services/i18n/config";

// Locale resolution order:
//   1. An explicit locale passed to `getTranslations({ locale })` / `getFormatter`
//      etc. (next-intl surfaces it as `requestLocale`). This is how server-side
//      senders render a member-facing email in the *recipient's* language rather
//      than the ambient request locale — see services/email/transactional.ts.
//   2. `locale` cookie set by the user (manual pick — always wins over browser)
//   3. `Accept-Language` negotiation against SUPPORTED_LOCALES
//   4. DEFAULT_LOCALE (English)
//
// In a normal page render nothing overrides the locale, so `requestLocale` is
// undefined and we fall through to the cookie — preserving prior behaviour.

type Messages = Record<string, unknown>;

// Deep-merge `override` onto `base`, returning a new object. Used to layer the
// active locale on top of English so any key missing from a translation falls
// back to its English string (instead of next-intl surfacing the raw key).
function mergeMessages(base: Messages, override: Messages): Messages {
  const out: Messages = { ...base };
  for (const key of Object.keys(override)) {
    const o = override[key];
    const b = out[key];
    if (
      o &&
      b &&
      typeof o === "object" &&
      typeof b === "object" &&
      !Array.isArray(o) &&
      !Array.isArray(b)
    ) {
      out[key] = mergeMessages(b as Messages, o as Messages);
    } else {
      out[key] = o;
    }
  }
  return out;
}

export default getRequestConfig(async ({ requestLocale }) => {
  // An explicit locale passed to `getTranslations({ locale })` wins (see the
  // resolution order above). Otherwise fall back to the cookie, then the
  // browser's Accept-Language.
  const requested = await requestLocale;

  let locale: string;
  if (requested && isSupportedLocale(requested)) {
    locale = requested;
  } else {
    const cookieStore = await cookies();
    const cookieLocale = cookieStore.get("locale")?.value;
    if (cookieLocale && isSupportedLocale(cookieLocale)) {
      locale = cookieLocale;
    } else {
      const h = await headers();
      locale = negotiateLocale(h.get("accept-language"));
    }
  }

  const fallback = (await import(`@/messages/${DEFAULT_LOCALE}.json`))
    .default as Messages;
  const messages =
    locale === DEFAULT_LOCALE
      ? fallback
      : mergeMessages(
          fallback,
          (await import(`@/messages/${locale}.json`)).default as Messages,
        );

  return {
    locale,
    messages,
  };
});
