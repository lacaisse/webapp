// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse, type NextRequest } from "next/server";

import { syncFundBankTransactions } from "@/services/bank-sync/ingest";
import { prisma } from "@/services/db/prisma";

// Vercel cron entry — see vercel.json. Polls CitizenPay for new bank
// movements on each connected fund, mirrors them locally, matches to
// members, and (for PAY_AND_GO funds) submits mints to CP. FIXED_PERIOD
// funds accumulate until the period close cron handles batch minting.
//
// A fund is "connected" when Fund.citizenPayFundId is set. Funds without
// it are skipped — there's nothing to ask CP about.

export async function GET(request: NextRequest) {
  const expected = process.env.CRON_SECRET;
  if (expected) {
    const auth = request.headers.get("authorization");
    if (auth !== `Bearer ${expected}`) {
      return new NextResponse("Unauthorized", { status: 401 });
    }
  }

  const funds = await prisma.fund.findMany({
    where: { citizenPayFundId: { not: null } },
    select: {
      id: true,
      name: true,
      citizenPayFundId: true,
      citizenPayLastSyncedAt: true,
      allocationMode: true,
    },
  });

  const results: Record<string, unknown> = {};
  for (const f of funds) {
    if (!f.citizenPayFundId) continue;
    try {
      const stats = await syncFundBankTransactions({
        id: f.id,
        name: f.name,
        citizenPayFundId: f.citizenPayFundId,
        citizenPayLastSyncedAt: f.citizenPayLastSyncedAt,
        allocationMode: f.allocationMode,
      });
      results[f.id] = stats;
    } catch (e) {
      console.error("[bank-sync-cron] fund failed", f.id, e);
      results[f.id] = { error: e instanceof Error ? e.message : "unknown" };
    }
  }

  return NextResponse.json({ funds: results });
}
