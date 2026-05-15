// SPDX-License-Identifier: AGPL-3.0-or-later
import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import {
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

  return {
    locale,
    messages: (await import(`@/messages/${locale}.json`)).default,
  };
});
