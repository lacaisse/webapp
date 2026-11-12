// SPDX-License-Identifier: AGPL-3.0-or-later
// Which host names this app serves, for the self-hosted platform's on-demand
// TLS (docs/container.md, `GET /api/internal/hostname-allowed`). The runner
// asks before it requests a certificate for a name it has never seen; the
// answer is yes only for:
//
//   - the apex (`APP_DOMAIN`) and the auth host (`auth.<APP_DOMAIN>`),
//   - `<sub>.<APP_DOMAIN>` when a fund lives there (stored canonically as
//     `<sub>.lacaisse.eu`, see services/fund/host.ts),
//   - a registered custom fund domain (`Fund.domain`, verbatim).
//
// Everything else is no: reserved infra subdomains (`www`, `api`, …), deeper
// names under the apex, malformed input, and — on any apex but the
// production one — the canonical `*.lacaisse.eu` form itself, which is where
// production serves those funds, not this deployment.
//
// Pure: the one database lookup is the caller's (the route), so this stays
// testable without Prisma.

import { FUND_APEX, toCanonicalFundDomain } from "@/services/fund/host";

const AUTH_SUBDOMAIN = "auth";
// Same list as proxy.ts: names that are never a fund.
const RESERVED_LABELS = new Set(["www", "api", "admin", "app"]);

// A lower-case DNS name: labels of letters, digits and inner hyphens, at
// most 63 characters each, 253 in all, no trailing dot. One label is allowed
// only for an apex like `localhost` (checked below).
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOSTNAME = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);

export type HostnameDecision =
  | { kind: "allow" }
  | { kind: "deny" }
  | { kind: "invalid" }
  // Allowed iff a fund's `domain` is exactly this value.
  | { kind: "lookup"; domain: string };

export function isValidHostname(value: string): boolean {
  return value.length > 0 && value.length <= 253 && HOSTNAME.test(value);
}

export function classifyHostname(
  hostname: string,
  appDomain: string,
): HostnameDecision {
  if (!isValidHostname(hostname)) return { kind: "invalid" };
  if (hostname === appDomain) return { kind: "allow" };
  if (hostname === `${AUTH_SUBDOMAIN}.${appDomain}`) return { kind: "allow" };

  const apexSuffix = `.${appDomain}`;
  if (hostname.endsWith(apexSuffix)) {
    const label = hostname.slice(0, -apexSuffix.length);
    // `a.b.<apex>` is never a fund: funds get exactly one label.
    if (label.includes(".")) return { kind: "deny" };
    if (RESERVED_LABELS.has(label)) return { kind: "deny" };
    return { kind: "lookup", domain: toCanonicalFundDomain(hostname, appDomain) };
  }

  // Not under this deployment's apex. On a non-production apex the canonical
  // `<sub>.lacaisse.eu` names belong to production; never claim them here.
  if (
    appDomain !== FUND_APEX &&
    (hostname === FUND_APEX || hostname.endsWith(`.${FUND_APEX}`))
  ) {
    return { kind: "deny" };
  }
  // A one-label name that is not the apex is not a custom domain.
  if (!hostname.includes(".")) return { kind: "deny" };
  return { kind: "lookup", domain: hostname };
}
