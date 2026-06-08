// SPDX-License-Identifier: AGPL-3.0-or-later
import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import {
  DEFAULT_LOCALE,
  isSupportedLocale,
  negotiateLocale,
} from "@/services/i18n/config";

// Locale resolution order:
//   1. `locale` cookie set by the user (manual pick — always wins)
//   2. `Accept-Language` negotiation against SUPPORTED_LOCALES
//   3. DEFAULT_LOCALE (English)
//
// Step 1 must come first or we'd overwrite the user's explicit choice with
// a browser default every request.

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

export default getRequestConfig(async () => {
  const cookieStore = await cookies();
  const cookieLocale = cookieStore.get("locale")?.value;

  let locale: string;
  if (cookieLocale && isSupportedLocale(cookieLocale)) {
    locale = cookieLocale;
  } else {
    const h = await headers();
    locale = negotiateLocale(h.get("accept-language"));
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
