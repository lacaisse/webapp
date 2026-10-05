// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { prisma } from "@/services/db/prisma";
import { getUserOpTx } from "@/services/token/userop";

import type { BurnAttempt } from "./burn-claim-config";

export type { BurnAttempt };

// What we know locally about the burn attempt behind an in-flight claim, so
// the payout page can tell the admin where to look on chain before they
// record or release it.
//
// The attempt is the TokenOperation `burnDirect` wrote: same fund, a BURN of
// exactly the payout `net` from the place's account, created at/after the
// claim. TokenOperation has no trigger or payout column, so account + amount
// + time is the match; and no userop column either, so the attempted userop
// hash is read back from the `[userOp 0x…]` suffix `burnDirect` appends to a
// failed row's `errorMessage`. A row still PENDING has no hash stored (it is
// only written when the attempt ends) — an attempt killed mid-flight shows as
// "still running".

const USEROP_IN_MESSAGE = /\[userOp (0x[0-9a-fA-F]{64})\]/;

export async function findBurnAttempt(args: {
  fundId: string;
  chainId: number;
  placeAccount: string;
  net: string;
  claimedAt: string;
}): Promise<BurnAttempt> {
  const since = new Date(args.claimedAt);
  if (Number.isNaN(since.getTime())) return { kind: "none" };

  const op = await prisma.tokenOperation.findFirst({
    where: {
      fundId: args.fundId,
      type: "BURN",
      account: { equals: args.placeAccount, mode: "insensitive" },
      amount: args.net,
      createdAt: { gte: since },
    },
    orderBy: { createdAt: "desc" },
    select: { status: true, txHash: true, errorMessage: true, createdAt: true },
  });
  if (!op) return { kind: "none" };

  if (op.status === "PENDING") {
    return { kind: "running", startedAt: op.createdAt.toISOString() };
  }
  if (op.status === "CONFIRMED" && op.txHash) {
    return { kind: "sent", userOpHash: null, txHash: op.txHash, status: "success" };
  }

  const userOpHash = op.errorMessage?.match(USEROP_IN_MESSAGE)?.[1] ?? null;
  if (!userOpHash) return { kind: "notSent" };
  try {
    const res = await getUserOpTx(args.chainId, userOpHash);
    return { kind: "sent", userOpHash, txHash: res.txHash, status: res.status };
  } catch (e) {
    console.warn("[payout] burn attempt status unavailable", userOpHash, e);
    return { kind: "sent", userOpHash, txHash: null, status: "unknown" };
  }
}
