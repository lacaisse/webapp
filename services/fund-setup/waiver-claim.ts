// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";
import { cache } from "react";

import type { Prisma, SubscriptionWaiverCode } from "@/services/db/generated/client";
import { prisma } from "@/services/db/prisma";

import {
  isWellFormedWaiverCode,
  normaliseWaiverCode,
  waiverCodeState,
} from "./waiver-codes";

// The two database halves of using a subscription waiver code, shared by every
// door a code opens: Settings → Subscription (admin-actions.ts::
// redeemWaiverCodeAction), the apex /join page (join-actions.ts) and
// /new?code= (services/fund/actions.ts, gated by services/auth/dal.ts::
// requireFundCreator). The pure rules — shape, normalisation, state — stay in
// waiver-codes.ts.

/**
 * The code a person typed, if it can be used right now: well-formed once
 * normalised, exists, active (not revoked, not expired, a use left). Null
 * for everything else, deliberately without saying why: on a public page an
 * unknown code and a used-up one must read the same (join.ts). Cached per
 * request so the /new gate and the page body share one read.
 */
export const findUsableWaiverCode = cache(
  async (raw: string): Promise<SubscriptionWaiverCode | null> => {
    const normalised = normaliseWaiverCode(raw);
    if (!isWellFormedWaiverCode(normalised)) return null;
    const code = await prisma.subscriptionWaiverCode.findUnique({
      where: { code: normalised },
    });
    if (!code || waiverCodeState(code) !== "active") return null;
    return code;
  },
);

/**
 * Claim one use of `code` inside `tx`: conditional on the code still being
 * active with a use left at `now`, so two redemptions of a code's last use
 * cannot both succeed. False = nothing was claimed; the caller must then
 * write nothing else (or throw, so the transaction rolls back).
 */
export async function claimWaiverCodeUse(
  tx: Prisma.TransactionClient,
  code: { id: string; maxUses: number },
  now: Date,
): Promise<boolean> {
  const claimed = await tx.subscriptionWaiverCode.updateMany({
    where: {
      id: code.id,
      revokedAt: null,
      usedCount: { lt: code.maxUses },
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    },
    data: { usedCount: { increment: 1 } },
  });
  return claimed.count > 0;
}
