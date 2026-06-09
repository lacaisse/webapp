// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse, type NextRequest } from "next/server";

import { closeExpiredPeriods } from "@/services/allocation-periods/close";
import { ensureOpenPeriodsForFixedFunds } from "@/services/allocation-periods/ensure";
import { cronGate } from "@/services/cron/guard";

// Vercel cron entry — see vercel.json. Finds AllocationPeriod rows that
// have hit their cutoff and runs the FIXED_PERIOD batch mint, then opens
// the next period. Also bootstraps a current open period for every connected
// FIXED_PERIOD fund (so funds with no deposits yet still get their first
// period). PAY_AND_GO funds have no periods and are skipped throughout.

export async function GET(request: NextRequest) {
  const gate = cronGate(request);
  if (gate) return gate;

  const results = await closeExpiredPeriods();
  const ensured = await ensureOpenPeriodsForFixedFunds();
  return NextResponse.json({
    closed: results.length,
    periods: results,
    ensured,
  });
}
