import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/services/db/prisma";

// Next 16 renamed `middleware.ts` to `proxy.ts` (function `proxy`).
// Two responsibilities:
//   1. Resolve the current fund (caisse) by exact host match against
//      `Fund.domain`. App code reads via services/fund/server.ts.
//   2. Refresh the Supabase session so server components see fresh tokens.
//
// There is no "slug" concept — the host IS the fund identity. Free funds
// happen to live on `<sub>.lacaisse.eu`, paid funds on their own domain.
// Both are stored verbatim in `Fund.domain`.

// Hosts that are NEVER funds — the apex itself plus reserved infra subdomains.
const RESERVED_HOSTS = new Set(["www", "api", "admin", "app"]);

export async function proxy(request: NextRequest) {
  // Always strip inbound fund headers — clients must never spoof tenancy.
  request.headers.delete("x-fund-domain");
  request.headers.delete("x-fund-id");

  const baseDomain = process.env.APP_DOMAIN ?? "localhost";
  const host = (request.headers.get("host") ?? "").split(":")[0];

  if (host && host !== baseDomain) {
    // Skip reserved infra subdomains (`www.lacaisse.eu`, etc.) without a DB hit.
    const isReservedSubdomain =
      host.endsWith(`.${baseDomain}`) &&
      RESERVED_HOSTS.has(host.slice(0, -(baseDomain.length + 1)));

    if (!isReservedSubdomain) {
      const fund = await prisma.fund.findUnique({
        where: { domain: host },
        select: { id: true, domain: true },
      });
      if (fund) {
        request.headers.set("x-fund-id", fund.id);
        request.headers.set("x-fund-domain", fund.domain);
      }
      // Unknown host → fall through; `requireCurrentFund()` will 404.
    }
  }

  let response = NextResponse.next({ request });

  // Supabase session refresh
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          for (const { name, value } of cookiesToSet) {
            request.cookies.set(name, value);
          }
          response = NextResponse.next({ request });
          for (const { name, value, options } of cookiesToSet) {
            response.cookies.set(name, value, options);
          }
        },
      },
    },
  );

  // IMPORTANT: getUser() is the only call that triggers a token refresh.
  // Do not add code between createServerClient and this call.
  await supabase.auth.getUser();

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
