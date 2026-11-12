// SPDX-License-Identifier: AGPL-3.0-or-later
import { connection, NextResponse } from "next/server";

// Liveness for the self-hosted platform (docs/container.md): the process is
// up and serving. No database, no host lookup — proxy.ts lets this path
// through on any Host without touching Postgres. Readiness, with the
// database, is /api/health/ready.

export async function GET() {
  // Rendered per request, never prerendered at build time.
  await connection();
  return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
}
