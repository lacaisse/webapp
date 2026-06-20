// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useEffect } from "react";

// Under Cache Components the root layout's static shell can't read the locale
// cookie (no request context at prerender time), so `<html lang>` ships as the
// build-time default. This syncs it to the user's actual locale on the client,
// from the same `locale` cookie that `i18n/request.ts` reads on the server.
export function HtmlLang() {
  useEffect(() => {
    const match = document.cookie.match(/(?:^|;\s*)locale=([^;]+)/);
    const locale = match?.[1];
    if (locale) document.documentElement.lang = decodeURIComponent(locale);
  }, []);
  return null;
}
