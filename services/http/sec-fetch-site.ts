// SPDX-License-Identifier: AGPL-3.0-or-later

// Cross-site guard for GET routes with side effects (the Citizen Pay
// handoff routes mint a single-use state row and 302 away). Browsers send
// `Sec-Fetch-Site` on every request: `same-origin` / `same-site` for a link
// or form on our own pages, `cross-site` for a link on someone else's page,
// `none` for a typed URL / bookmark. Only our own pages link to these
// routes, so anything else is refused. A missing header (old browser,
// curl) is let through — the routes are still behind the fund-admin
// session, this is defence in depth, not the auth.
const ALLOWED_SITES = new Set(["same-origin", "same-site"]);

export function isCrossSiteRequest(headers: Headers): boolean {
  const site = headers.get("sec-fetch-site");
  if (site === null) return false;
  return !ALLOWED_SITES.has(site.trim().toLowerCase());
}
