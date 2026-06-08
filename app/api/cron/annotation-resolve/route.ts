// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse, type NextRequest } from "next/server";

import { cronGate } from "@/services/cron/guard";
import { processPendingAnnotations } from "@/services/transaction-annotation/pending";

// Vercel cron entry — see vercel.json. Resolves queued userOp hashes (CP's
// payout fee sweeps) to their settlement tx hash and writes the annotation
// keyed by that real hash, so it lines up with the on-chain transfer history.
export async function GET(request: NextRequest) {
  const gate = cronGate(request);
  if (gate) return gate;

  const result = await processPendingAnnotations();
  return NextResponse.json(result);
}
