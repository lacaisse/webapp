// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";

import { PRIVACY_COOKIE, isPrivacyCookieOn } from "@/lib/privacy";

// Whether the current request has privacy mode on. Read once per render
// (React cache) — the (fund) layout uses it to seed the client provider, and
// server components that build strings (CSV exports, PDF letters) must NOT
// consult it: privacy mode is a display-only mask, never a data filter.
export const getPrivacyMode = cache(async (): Promise<boolean> => {
  const store = await cookies();
  return isPrivacyCookieOn(store.get(PRIVACY_COOKIE)?.value);
});
