// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { NextResponse, type NextRequest } from "next/server";

// Shared gate for Vercel cron routes. Two checks:
//
//  1. Production only. Vercel only *schedules* crons on prod, but the routes
//     are public URLs reachable from preview/local too — refuse those so a
//     branch deploy or a stray local request can't touch real data / race
//     prod. Override with `CRON_ALLOW_NONPROD=true` for manual testing.
//  2. Authenticate via `CRON_SECRET` — Vercel injects
//     `Authorization: Bearer ${CRON_SECRET}` on cron-triggered requests. When
//     the secret is unset (local), this check is skipped.
//
// Returns a Response to short-circuit the handler with, or null to proceed.
export function cronGate(request: NextRequest): NextResponse | null {
  if (
    process.env.VERCEL_ENV !== "production" &&
    process.env.CRON_ALLOW_NONPROD !== "true"
  ) {
    return NextResponse.json({ skipped: "non-production" });
  }

  const expected = process.env.CRON_SECRET;
  if (expected) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${expected}`) {
      return new NextResponse("Unauthorized", { status: 401 });
    }
  }

  return null;
}
