// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse, type NextRequest } from "next/server";

import { closeExpiredPeriods } from "@/services/allocation-periods/close";
import { cronGate } from "@/services/cron/guard";

// Vercel cron entry — see vercel.json. Finds AllocationPeriod rows that
// have hit their cutoff and runs the FIXED_PERIOD batch mint, then opens
// the next period. PAY_AND_GO funds don't have periods so this cron skips
// them implicitly (it only touches OPEN periods past cutoff).

export async function GET(request: NextRequest) {
  const gate = cronGate(request);
  if (gate) return gate;

  const results = await closeExpiredPeriods();
  return NextResponse.json({ closed: results.length, periods: results });
}
