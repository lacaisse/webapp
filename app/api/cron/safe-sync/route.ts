// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse, type NextRequest } from "next/server";
import { cronGate } from "@/services/cron/guard";
import { syncAllPendingSafes } from "@/services/safe/sync";

// Vercel cron entry — see vercel.json. Mirrors every fund Safe with open
// transactions (or not synced for an hour) from the chain and the Safe
// Transaction Service: imports Safe{Wallet} confirmations, records external
// executions, supersedes consumed nonces, recovers stuck executions, and
// executes whatever now meets its threshold. Each safe is synced under its
// own fundId (services/safe/sync.ts).

export async function GET(request: NextRequest) {
  const gate = cronGate(request);
  if (gate) return gate;

  const result = await syncAllPendingSafes();
  return NextResponse.json(result);
}
