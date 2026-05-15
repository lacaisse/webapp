// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { cache } from "react";
import { prisma } from "@/services/db/prisma";
import { toRoutableFundHost } from "./host";

// The current fund (caisse) is identified by the request host. proxy.ts
// performs the lookup against `Fund.domain` and forwards `x-fund-domain` +
// `x-fund-id`. App code reads the fund through these helpers — never
// re-parse the host or query the DB directly for the current fund.

export const getCurrentFundDomain = cache(async () => {
  const h = await headers();
  return h.get("x-fund-domain");
});

export const getCurrentFund = cache(async () => {
  const h = await headers();
  const fundId = h.get("x-fund-id");
  if (!fundId) return null;
  return prisma.fund.findUnique({ where: { id: fundId } });
});

export const requireCurrentFund = cache(async () => {
  const fund = await getCurrentFund();
  if (!fund) notFound();
  return fund;
});

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
