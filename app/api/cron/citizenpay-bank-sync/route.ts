// SPDX-License-Identifier: AGPL-3.0-or-later
import { NextResponse, type NextRequest } from "next/server";

import { syncFundBankTransactions } from "@/services/bank-sync/ingest";
import { sweepCardTopUps } from "@/services/card-topup/settle";
import { cronGate } from "@/services/cron/guard";
import { prisma } from "@/services/db/prisma";

// Vercel cron entry — see vercel.json. Polls CitizenPay for new bank
// movements on each connected fund, mirrors them locally, matches to
// members, and (for PAY_AND_GO funds) submits mints to CP. FIXED_PERIOD
// funds accumulate until the period close cron handles batch minting.
//
// Then the open-banking card top-up safety net: top-ups still PENDING /
// SIGNED a minute after they started are re-checked against CP and finished
// (signed → mint, expired / cancelled → closed), so a member who closed the
// tab after paying still gets credited. See services/card-topup/settle.ts.
//
// A fund is "connected" when Fund.citizenPayFundId is set. Funds without
// it are skipped — there's nothing to ask CP about.
//
// Production only. We never auto-poll CP from dev or preview deployments —
// dev runs against the in-process mock and we don't want preview branches
// racing prod for the same treasuries. Admins can still trigger a sync
// manually from the Bank page (see services/bank/admin-actions.ts).

export async function GET(request: NextRequest) {
  const gate = cronGate(request);
  if (gate) return gate;

  const funds = await prisma.fund.findMany({
    where: { citizenPayFundId: { not: null } },
    select: {
      id: true,
      name: true,
      citizenPayFundId: true,
      citizenPayApiKeyId: true,
      citizenPayApiKeyEnc: true,
      tokenChainId: true,
      citizenPayLastSyncedAt: true,
      allocationMode: true,
      allocationCutoffDay: true,
      confirmationEmailsPausedAt: true,
      primaryColor: true,
      logoUrl: true,
      senderEmail: true,
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
        citizenPayApiKeyId: f.citizenPayApiKeyId,
        citizenPayApiKeyEnc: f.citizenPayApiKeyEnc,
        tokenChainId: f.tokenChainId,
        citizenPayLastSyncedAt: f.citizenPayLastSyncedAt,
        allocationMode: f.allocationMode,
        allocationCutoffDay: f.allocationCutoffDay,
        confirmationEmailsPausedAt: f.confirmationEmailsPausedAt,
        primaryColor: f.primaryColor,
        logoUrl: f.logoUrl,
        senderEmail: f.senderEmail,
      });
      results[f.id] = stats;
    } catch (e) {
      console.error("[bank-sync-cron] fund failed", f.id, e);
      results[f.id] = { error: e instanceof Error ? e.message : "unknown" };
    }
  }

  // Funds with open top-ups (usually none): load the full row — the mint
  // needs the minter / token columns.
  const topUps: Record<string, unknown> = {};
  const open = await prisma.cardTopUp.findMany({
    where: { status: { in: ["PENDING", "SIGNED"] } },
    distinct: ["fundId"],
    select: { fundId: true },
  });
  for (const { fundId } of open) {
    try {
      const fund = await prisma.fund.findUnique({ where: { id: fundId } });
      if (!fund?.citizenPayFundId) continue;
      topUps[fundId] = await sweepCardTopUps(fund);
    } catch (e) {
      console.error("[bank-sync-cron] top-up sweep failed", fundId, e);
      topUps[fundId] = { error: e instanceof Error ? e.message : "unknown" };
    }
  }

  return NextResponse.json({ funds: results, topUps });
}
