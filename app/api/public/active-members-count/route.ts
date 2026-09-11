// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse } from "next/server";

import { getCurrentFund } from "@/services/fund/server";
import { countPublicActiveMembers } from "@/services/member/public-count";

// Public member counter for external sites (issue #198): the org's own
// homepage (e.g. laclass.be) fetches this — typically server-side — to show
// how many people participate in the fund.
//
// Deliberately unauthenticated: the response is a single aggregate number
// scoped to the fund whose domain was hit, which proxy.ts resolved from the
// Host header — no client input picks the fund, so one fund's host can never
// serve another fund's count. CORS is open because the number is public by
// design, and the CDN cache below keeps repeated fetches (or abuse) off the
// database.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

export async function GET() {
  const fund = await getCurrentFund();
  // Apex / auth hosts have no fund — the counter only exists on a fund domain.
  if (!fund) {
    return NextResponse.json(
      { error: "not_found" },
      { status: 404, headers: CORS_HEADERS },
    );
  }

  const activeMembers = await countPublicActiveMembers(fund.id);
  return NextResponse.json(
    { activeMembers },
    {
      headers: {
        ...CORS_HEADERS,
        // A membership counter can lag a few minutes; let Vercel's CDN absorb
        // the traffic instead of hitting Postgres per page view.
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=3600",
      },
    },
  );
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}
