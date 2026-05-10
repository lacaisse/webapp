import "server-only";
import { prisma } from "@/services/db/prisma";
import { toCanonicalFundDomain } from "@/services/fund/host";
import { AUTH_SUBDOMAIN } from "@/services/host/server";

// Validate a `return_to` URL submitted by the client before we redirect into
// it. Allowed targets: the apex itself or any host registered as `Fund.domain`
// (a free `<sub>.<APP_DOMAIN>` subdomain or a paid custom domain). The auth
// host is never a valid target — it's the source of every redirect, never the
// destination.

export type AllowedReturnTo = { origin: string; path: string };

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
    return { origin: url.origin, path };
  }

  const fund = await prisma.fund.findUnique({
    where: { domain: toCanonicalFundDomain(host, apex) },
    select: { id: true },
  });
  if (!fund) throw new Error("unknown return target");

  return { origin: url.origin, path };
}
