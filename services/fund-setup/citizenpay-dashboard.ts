// SPDX-License-Identifier: AGPL-3.0-or-later
import { DEFAULT_CITIZENPAY_DASHBOARD_URL } from "./config";

// Links into the Citizen Pay dashboard, where the treasury's business connects
// its bank (open banking) and reads its invoices. The pages are the dashboard
// routes `src/app/(dashboard)/[businessId]/banking` and `.../billing`, keyed
// by `Fund.citizenPayBusinessId`.
//
// Pure: the base URL is a parameter, never read from env here, so client
// components and tests can call it. This module owns the normalisation and
// the default: callers pass the configured value as is (the server data
// layer passes `process.env.CITIZENPAY_DASHBOARD_URL`, possibly unset).

export type CitizenPayDashboardUrls = { home: string; banking: string; billing: string };

// Trims, strips trailing slashes, and falls back to the default dashboard when
// nothing usable is configured (an empty env var counts as unset).
export function normaliseDashboardBaseUrl(raw: string | undefined | null): string {
  const trimmed = (raw ?? "").trim().replace(/\/+$/, "");
  return trimmed === "" ? DEFAULT_CITIZENPAY_DASHBOARD_URL : trimmed;
}

// Without a cached business id both pages fall back to the dashboard root,
// which redirects the signed-in user to their business.
export function citizenPayDashboardUrls(
  baseUrl: string | undefined | null,
  businessId: string | null,
): CitizenPayDashboardUrls {
  const base = normaliseDashboardBaseUrl(baseUrl);
  const home = `${base}/`;
  if (businessId == null || businessId.trim() === "") {
    return { home, banking: home, billing: home };
  }
  const business = `${base}/${encodeURIComponent(businessId.trim())}`;
  return { home, banking: `${business}/banking`, billing: `${business}/billing` };
}
