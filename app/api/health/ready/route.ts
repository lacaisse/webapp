// SPDX-License-Identifier: AGPL-3.0-or-later
import { connection, NextResponse } from "next/server";

import { containerOnly } from "@/services/cron/guard";
import { databaseReady } from "@/services/db/health";

// Readiness for the self-hosted platform (docs/container.md): 200 when the
// database answers `SELECT 1` within 2 s, 503 otherwise. The runner's green
// health check uses this path, so a container that cannot reach Postgres
// (wrong URL, wrong CA, database down) never takes traffic. The body says
// nothing about why: the reason is logged. Exists only in the container
// image (DEPLOY_TARGET=container); anywhere else an empty 404, so Vercel
// gains no public route that touches the database.

export async function GET() {
  await connection();
  const missing = containerOnly();
  if (missing) return missing;
  const ready = await databaseReady();
  return NextResponse.json(
    { ok: ready },
    { status: ready ? 200 : 503, headers: { "Cache-Control": "no-store" } },
  );
}
