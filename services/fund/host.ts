// SPDX-License-Identifier: AGPL-3.0-or-later
// `Fund.domain` always stores the canonical production hostname
// (`<sub>.lacaisse.eu` for free funds, the verbatim domain for paid custom
// domains). Dev runs on a different apex (`localhost`), so the proxy and
// outgoing-URL helpers translate between the two forms here.
//
// Everything here is pure host-string arithmetic over `Fund.domain` and the
// environment — no headers, no DB. `./server.ts` re-exports the URL builders
// so app code keeps its single import site (see AGENTS.md); import them from
// here only when the caller must stay free of the server-only graph.

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

/**
 * Build the public URL for a fund on the current environment. `domain` is
 * the value stored on `Fund.domain` (the canonical production hostname).
 * In dev that gets translated back to the routable `<sub>.localhost` host.
 * Use this for cross-host links — `<Link>` won't work because Next's client
 * router can't navigate to a different host.
 */
export function getFundUrl(domain: string): string {
  const apex = process.env.APP_DOMAIN ?? "localhost";
  return buildHostUrl(toRoutableFundHost(domain, apex));
}

/** Build an apex URL — use for cross-host redirects from fund subdomains. */
export function getApexUrl(path = "/"): string {
  const apex = process.env.APP_DOMAIN ?? "localhost";
  return `${buildHostUrl(apex)}${path}`;
}

function buildHostUrl(host: string): string {
  const isProd = process.env.NODE_ENV === "production";
  const protocol = isProd ? "https" : "http";
  const port = isProd ? "" : `:${process.env.PORT ?? 3000}`;
  return `${protocol}://${host}${port}`;
}
