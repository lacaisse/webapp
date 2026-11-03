// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";
import { headers } from "next/headers";
import { cache } from "react";

// Three host kinds — auth (centralized login on `auth.lacaisse.eu`), apex
// (`lacaisse.eu`), and fund (any fund's canonical domain). proxy.ts classifies
// each request and forwards `x-host-type` so app code never re-parses Host.

export type HostType = "auth" | "apex" | "fund";

export const AUTH_SUBDOMAIN = "auth";

export const getHostType = cache(async (): Promise<HostType> => {
  const h = await headers();
  const t = h.get("x-host-type");
  if (t === "auth" || t === "apex" || t === "fund") return t;
  // Fallback if proxy didn't classify (unknown host) — treat as apex so
  // requireCurrentFund() can decide whether to 404.
  return h.get("x-fund-domain") ? "fund" : "apex";
});

/**
 * Build a URL on the centralized auth host (`auth.<APP_DOMAIN>`). Use for
 * cross-host redirects into the login flow — the host is not navigable via
 * Next's `<Link>` because it's a different origin.
 */
export function getAuthUrl(path = "/"): string {
  const apex = process.env.APP_DOMAIN ?? "localhost";
  return `${buildHostUrl(`${AUTH_SUBDOMAIN}.${apex}`)}${path}`;
}

function buildHostUrl(host: string): string {
  const isProd = process.env.NODE_ENV === "production";
  const protocol = isProd ? "https" : "http";
  const port = isProd ? "" : `:${process.env.PORT ?? 3000}`;
  return `${protocol}://${host}${port}`;
}

/**
 * True while rendering as part of a Server Action request (Next re-renders
 * the current page inside the action's response). A `redirect()` thrown in
 * that re-render is resolved by an internal fetch against the server's own
 * origin — the apex, not the fund host the browser is on — so host-routed
 * pages (the member pages behind proxy.ts' rewrite) must not redirect
 * there: the form navigates with `window.location` once the action answers,
 * and the re-rendered payload is discarded.
 */
export async function isServerActionRequest(): Promise<boolean> {
  return (await headers()).has("next-action");
}
