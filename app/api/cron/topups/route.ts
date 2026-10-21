// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse, type NextRequest } from "next/server";

import { cronGate } from "@/services/cron/guard";
import { prisma } from "@/services/db/prisma";
import { runTopUpOrders } from "@/services/topup-orders/run";

// Vercel cron entry — see vercel.json (every minute). Terminal top-ups: for
// every fund connected to a Citizen Pay treasury with a minter Safe, list the
// top-ups members paid at a pay-pos terminal, mint them to the card with the
// fund's own minter and report the hash; burn back the refunded ones. See
// services/topup-orders/run.ts for the claim / idempotency rules.
//
// One fund's failure never blocks the others: each run is isolated and its
// outcome is both returned here and recorded on the Fund row.

export async function GET(request: NextRequest) {
  const gate = cronGate(request);
  if (gate) return gate;

  const funds = await prisma.fund.findMany({
    where: {
      citizenPayFundId: { not: null },
      tokenMinterSmartAccountAddress: { not: null },
    },
    orderBy: { createdAt: "asc" },
  });

  const results: Record<string, unknown> = {};
  for (const fund of funds) {
    try {
      results[fund.id] = await runTopUpOrders(fund);
    } catch (e) {
      console.error("[topups-cron] fund failed", fund.id, e);
      results[fund.id] = { error: e instanceof Error ? e.message : "unknown" };
    }
  }
  return NextResponse.json({ funds: results });
}
