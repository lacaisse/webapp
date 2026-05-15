// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { getCitizenPayClient } from "@/services/citizenpay/client";
import { prisma } from "@/services/db/prisma";

// Resubmission for TokenOperation rows that never got a txHash. These end
// up in this state when the initial submitMint call to CP failed (network
// blip, transient outage, etc.). The status-polling cron skips them
// because it can only poll ops that *have* a txHash, so without this retry
// they'd sit PENDING forever.
//
// Scope: MINT operations only. BURN/TRANSFER follow different rules — we
// don't auto-retry them. Failed (status=FAILED) ops are also out of scope:
// those got a verdict from CP and need admin attention.

const BATCH_SIZE = 50;

export type RetryStats = {
  attempted: number;
  submitted: number;
  failed: number;
};

export async function retryPendingMints(): Promise<RetryStats> {
  const ops = await prisma.tokenOperation.findMany({
    where: {
      type: "MINT",
      status: "PENDING",
      txHash: null,
    },
    orderBy: { submittedAt: "asc" },
    take: BATCH_SIZE,
    select: {
      id: true,
      account: true,
      amount: true,
      fund: { select: { citizenPayFundId: true } },
    },
  });

  const cp = getCitizenPayClient();
  let submitted = 0;
  let failed = 0;

  for (const op of ops) {
    try {
      const result = await cp.submitMint({
        fundCitizenPayId: op.fund.citizenPayFundId,
        toAccount: op.account,
        amount: op.amount.toString(),
        // Pass op.id as the reference so a live CP API can dedupe if we
        // accidentally re-send the same logical mint twice (cron overlap,
        // rare on Vercel but possible).
        reference: op.id,
      });
      await prisma.tokenOperation.update({
        where: { id: op.id },
        data: { txHash: result.txHash },
      });
      submitted++;
    } catch (e) {
      console.error("[mint-retry] submit failed", op.id, e);
      failed++;
      // Leave PENDING with null txHash — next tick tries again. No backoff
      // for v1; add `lastAttemptedAt` + `attemptCount` columns when we
      // need bounded retries.
    }
  }

  return { attempted: ops.length, submitted, failed };
}
