// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse, type NextRequest } from "next/server";

import { cronGate } from "@/services/cron/guard";
import { retryPendingMints } from "@/services/token-operations/retry";

// Vercel cron entry — see vercel.json. Re-submits TokenOperation rows in
// PENDING with no txHash (initial submit-to-CP failed). Complements the
// status-polling cron, which only handles ops with a txHash.

export async function GET(request: NextRequest) {
  const gate = cronGate(request);
  if (gate) return gate;

  const stats = await retryPendingMints();
  return NextResponse.json(stats);
}
