// SPDX-License-Identifier: AGPL-3.0-or-later
// `Fund.domain` always stores the canonical production hostname
// (`<sub>.lacaisse.eu` for free funds, the verbatim domain for paid custom
// domains). Dev runs on a different apex (`localhost`), so the proxy and
// outgoing-URL helpers translate between the two forms here.

export const FUND_APEX = "lacaisse.eu";

/**
 * Inbound host → stored `Fund.domain`. If the host sits under the dev apex
 * (`acme.localhost`), rewrite it to the canonical `acme.lacaisse.eu` for the
 * DB lookup. Hosts that don't end with the dev apex (production, custom
 * domains) pass through unchanged.
 */
export function toCanonicalFundDomain(host: string, appDomain: string): string {
  if (appDomain === FUND_APEX) return host;
  const suffix = `.${appDomain}`;
  if (!host.endsWith(suffix)) return host;
  return `${host.slice(0, -suffix.length)}.${FUND_APEX}`;
}

/**
 * Stored `Fund.domain` → routable host for the current environment. In dev,
 * `acme.lacaisse.eu` becomes `acme.localhost` so links actually resolve.
 * Custom domains and prod hosts pass through unchanged.
 */
export function toRoutableFundHost(
  domain: string,
  appDomain: string,
): string {
  if (appDomain === FUND_APEX) return domain;
  const suffix = `.${FUND_APEX}`;
  if (!domain.endsWith(suffix)) return domain;
  return `${domain.slice(0, -suffix.length)}.${appDomain}`;
}
