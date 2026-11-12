// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";

import { NextResponse, type NextRequest } from "next/server";

// Shared gate for the cron routes, and for the internal / maintenance routes
// the self-hosted platform calls with the same bearer
// (`/api/internal/hostname-allowed`, `/api/maintenance/reencrypt-app-cred`).
// Two checks:
//
//  1. Production only. Vercel only *schedules* crons on prod, but the routes
//     are public URLs reachable from preview/local too — refuse those so a
//     branch deploy or a stray local request can't touch real data / race
//     prod. Override with `CRON_ALLOW_NONPROD=true` for manual testing.
//     A container image (`DEPLOY_TARGET=container`, set by the Dockerfile)
//     counts as production: on the self-hosted platform the runner is the
//     scheduler and every environment it runs (staging included) is that
//     environment's real deployment.
//  2. Authenticate via `CRON_SECRET` — Vercel (or the runner) sends
//     `Authorization: Bearer ${CRON_SECRET}` on cron-triggered requests. In
//     production the secret is mandatory: unset means every cron route
//     answers 503 rather than running for anyone who finds the URL (review
//     S19). Outside production (CRON_ALLOW_NONPROD) an unset secret skips
//     the check, for local runs.
//
// Returns a Response to short-circuit the handler with, or null to proceed.
export function cronGate(request: NextRequest): NextResponse | null {
  // Read the request before anything else. With Cache Components, Next
  // prerenders a GET route handler at build time unless it touches the
  // request; a gate that answered from the environment alone (the skip
  // below) got frozen into a static `{"skipped":"non-production"}` by any
  // build made without VERCEL_ENV=production — the container build
  // (docs/container.md) is one. Vercel's production build reached the
  // header read and so stayed dynamic; now every build does.
  const auth = request.headers.get("authorization");
  const production = isProductionDeployment();
  if (!production && process.env.CRON_ALLOW_NONPROD !== "true") {
    return NextResponse.json({ skipped: "non-production" });
  }

  const expected = process.env.CRON_SECRET;
  if (!expected && production) {
    console.error("[cron] CRON_SECRET is not set — refusing to run cron routes");
    return new NextResponse("Cron secret not configured", { status: 503 });
  }
  if (expected) {
    if (!bearerMatches(auth, expected)) {
      return new NextResponse("Unauthorized", { status: 401 });
    }
  }

  return null;
}

/**
 * Vercel production, or the container image. Vercel never sets
 * DEPLOY_TARGET, so on Vercel this is exactly `VERCEL_ENV === "production"`.
 */
export function isProductionDeployment(): boolean {
  return (
    process.env.VERCEL_ENV === "production" || isContainerDeployment()
  );
}

/**
 * `Authorization` equals `Bearer <secret>`, compared in constant time: both
 * sides are hashed to the same length first, so neither the content nor the
 * length of the secret leaks through timing.
 */
export function bearerMatches(header: string | null, secret: string): boolean {
  const got = createHash("sha256").update(header ?? "").digest();
  const want = createHash("sha256").update(`Bearer ${secret}`).digest();
  return timingSafeEqual(got, want);
}

/** The container image (Dockerfile). Never true on Vercel. */
export function isContainerDeployment(): boolean {
  return process.env.DEPLOY_TARGET === "container";
}

/**
 * The platform-only routes (hostname-allowed, re-encryption, readiness)
 * exist only in the container image; anywhere else they answer like a
 * missing route, with an empty 404.
 */
export function containerOnly(): NextResponse | null {
  if (isContainerDeployment()) return null;
  return new NextResponse(null, { status: 404, headers: { "Cache-Control": "no-store" } });
}
