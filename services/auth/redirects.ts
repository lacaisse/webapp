// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";
import { prisma } from "@/services/db/prisma";
import { getApexUrl } from "@/services/fund/server";
import { toCanonicalFundDomain } from "@/services/fund/host";
import { AUTH_SUBDOMAIN } from "@/services/host/server";
import { issueExchangeCode } from "./exchange";

// Validate a `return_to` URL submitted by the client before we redirect into
// it. Allowed targets: the apex itself or any host registered as `Fund.domain`
// (a free `<sub>.<APP_DOMAIN>` subdomain or a paid custom domain). The auth
// host is never a valid target — it's the source of every redirect, never the
// destination.

export type AllowedReturnTo = { origin: string; host: string; path: string };

/**
 * Validate `return_to` and fall back to the apex when missing or invalid.
 * Returns an absolute URL. Used by every post-login redirect (forms,
 * already-signed-in short-circuits) so the rules live in one place.
 */
export async function resolveReturnTo(
  returnTo: string | null | undefined,
): Promise<string> {
  if (!returnTo) return getApexUrl("/");
  try {
    await assertReturnToAllowed(returnTo);
    return returnTo;
  } catch {
    return getApexUrl("/");
  }
}

export async function assertReturnToAllowed(
  returnTo: string,
): Promise<AllowedReturnTo> {
  const url = new URL(returnTo); // throws on invalid

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("invalid return_to protocol");
  }

  const host = url.hostname;
  const apex = process.env.APP_DOMAIN ?? "localhost";

  if (host === `${AUTH_SUBDOMAIN}.${apex}`) {
    throw new Error("auth host is not a valid return target");
  }

  const path = `${url.pathname}${url.search}`;

  if (host === apex) {
    return { origin: url.origin, host, path };
  }

  const fund = await prisma.fund.findUnique({
    where: { domain: toCanonicalFundDomain(host, apex) },
    select: { id: true },
  });
  if (!fund) throw new Error("unknown return target");

  return { origin: url.origin, host, path };
}

/**
 * Post-auth handoff. Given a freshly authenticated user and an optional
 * `returnTo`, mint a single-use exchange code bound to the resolved target
 * host and return the absolute URL the browser should be redirected to:
 * `<target>/auth/exchange?code=...&return_to=<path>`. The target host's
 * `/auth/exchange` route consumes the code and writes its own session cookie.
 *
 * Falls back to the apex root when `returnTo` is missing or unsafe. This is
 * the single entry point for cross-host handoff — every action that signs
 * a user in on the auth host should go through here, never `redirect(...)`
 * directly to a non-auth origin.
 */
export async function buildPostAuthRedirect(args: {
  userId: string;
  email: string;
  returnTo?: string | null;
}): Promise<string> {
  const target = await resolveTarget(args.returnTo);
  const code = await issueExchangeCode({
    userId: args.userId,
    email: args.email,
    targetHost: target.host,
  });
  const params = new URLSearchParams({ code });
  if (target.path && target.path !== "/") params.set("return_to", target.path);
  return `${target.origin}/auth/exchange?${params.toString()}`;
}

async function resolveTarget(
  returnTo: string | null | undefined,
): Promise<AllowedReturnTo> {
  if (returnTo) {
    try {
      return await assertReturnToAllowed(returnTo);
    } catch {
      // fall through to apex
    }
  }
  const apexUrl = new URL(getApexUrl("/"));
  return { origin: apexUrl.origin, host: apexUrl.hostname, path: "/" };
}
