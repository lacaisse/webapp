import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/services/db/prisma";
import { toCanonicalFundDomain } from "@/services/fund/host";

// Next 16 renamed `middleware.ts` to `proxy.ts` (function `proxy`).
// Two responsibilities:
//   1. Classify the request host into one of: `auth` (centralized login on
//      `auth.<APP_DOMAIN>`), `apex` (the apex itself or reserved infra
//      subdomains), or `fund` (a Fund.domain match — subdomain or custom
//      domain). Forwarded as `x-host-type`.
//   2. For `fund` hosts, forward `x-fund-id` / `x-fund-domain` so app code
//      doesn't re-parse Host. Read via services/fund/server.ts.
//
// Session refresh is NOT done here — Better Auth uses DB-backed sessions
// looked up on-demand by services/auth/dal.ts#getCurrentUser; the
// nextCookies() plugin handles cookie writes on Server Action responses.
//
// There is no "slug" concept — the host IS the fund identity. Free funds
// happen to live on `<sub>.lacaisse.eu`, paid funds on their own domain.
// Both are stored verbatim in `Fund.domain`.

const AUTH_SUBDOMAIN = "auth";
// Hosts that are NEVER funds — reserved infra subdomains. Treated as apex
// for routing purposes (app code can still 404 on a per-route basis).
const RESERVED_HOSTS = new Set(["www", "api", "admin", "app"]);

export async function proxy(request: NextRequest) {
  // Always strip inbound proxy-controlled headers — clients must never spoof
  // host classification or fund context.
  request.headers.delete("x-fund-domain");
  request.headers.delete("x-fund-id");
  request.headers.delete("x-host-type");
  request.headers.delete("x-pathname");
  request.headers.delete("x-search");

  // Forward the request path so DAL helpers (requireUser) can build a
  // return_to without re-parsing the URL.
  request.headers.set("x-pathname", request.nextUrl.pathname);
  if (request.nextUrl.search) {
    request.headers.set("x-search", request.nextUrl.search);
  }

  const baseDomain = process.env.APP_DOMAIN ?? "localhost";
  const host = (request.headers.get("host") ?? "").split(":")[0];

  let hostType: "auth" | "apex" | "fund" | undefined;

  if (!host || host === baseDomain) {
    hostType = "apex";
  } else if (host === `${AUTH_SUBDOMAIN}.${baseDomain}`) {
    hostType = "auth";
  } else if (
    host.endsWith(`.${baseDomain}`) &&
    RESERVED_HOSTS.has(host.slice(0, -(baseDomain.length + 1)))
  ) {
    // Reserved infra subdomain (`www.lacaisse.eu`, etc.) — not a fund. Treat
    // as apex so it doesn't accidentally get the auth/fund handling.
    hostType = "apex";
  } else {
    // Translate dev hosts (`acme.localhost`) back to the canonical
    // production form (`acme.lacaisse.eu`) before looking up the Fund —
    // `Fund.domain` always stores the canonical hostname. Custom domains
    // pass through unchanged.
    const lookupHost = toCanonicalFundDomain(host, baseDomain);
    const fund = await prisma.fund.findUnique({
      where: { domain: lookupHost },
      select: { id: true, domain: true },
    });
    if (fund) {
      request.headers.set("x-fund-id", fund.id);
      request.headers.set("x-fund-domain", fund.domain);
      hostType = "fund";
    }
    // Unknown host → no hostType set; downstream helpers default to apex/404.
  }

  if (hostType) {
    request.headers.set("x-host-type", hostType);
  }

  return NextResponse.next({ request });
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
