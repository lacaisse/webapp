// SPDX-License-Identifier: AGPL-3.0-or-later
import { connection, NextResponse, type NextRequest } from "next/server";

import { containerOnly, cronGate } from "@/services/cron/guard";
import { prisma } from "@/services/db/prisma";
import { classifyHostname } from "@/services/host/hostname-allowed";

// On-demand TLS permission for the self-hosted platform (docs/container.md):
// the runner asks `GET /api/internal/hostname-allowed?hostname=<fqdn>` with
// the cron bearer before it requests a certificate for a name. 200 = this
// app serves that name, 404 = it does not. The runner treats any other
// answer (401, 503, 5xx, timeout) as no.
//
// Exists only in the container image (DEPLOY_TARGET=container): anywhere
// else, Vercel included, an empty 404. Then guarded exactly like the cron
// routes (services/cron/guard.ts).
//
// Bodies are empty: the status is the whole answer. One indexed lookup on
// `Fund.domain` (unique), never a listing.

function answer(status: 200 | 400 | 404): NextResponse {
  return new NextResponse(null, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: NextRequest) {
  // Per request, never prerendered: the environment check must run at
  // request time (the build has no DEPLOY_TARGET).
  await connection();
  const missing = containerOnly();
  if (missing) return missing;
  const gate = cronGate(request);
  if (gate) return gate;

  const params = request.nextUrl.searchParams.getAll("hostname");
  if (params.length !== 1) return answer(400);

  const appDomain = process.env.APP_DOMAIN ?? "localhost";
  const decision = classifyHostname(params[0]!, appDomain);
  switch (decision.kind) {
    case "invalid":
      return answer(400);
    case "deny":
      return answer(404);
    case "allow":
      return answer(200);
    case "lookup": {
      const fund = await prisma.fund.findUnique({
        where: { domain: decision.domain },
        select: { id: true },
      });
      return answer(fund ? 200 : 404);
    }
  }
}
