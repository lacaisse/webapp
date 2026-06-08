// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { prisma } from "@/services/db/prisma";
import { getUserOpTx } from "@/services/token/userop";

import { annotateTransaction } from "./annotate";

// Async resolution of userOp hashes → real tx hashes, then annotate. CP returns
// userOp hashes for the payout fee sweep, which never match the on-chain
// transfer history (keyed by the settlement tx hash). Rather than block the
// action, we queue the userOp hash and let the cron resolve it.

// Poll cap: a userOp settles in seconds, so this only bounds genuinely stuck
// entries. At the cron's cadence this is well over an hour of retries.
const MAX_ATTEMPTS = 30;

// Queue a userOp hash for resolution. Idempotent on (fundId, userOpHash); a
// re-queue leaves the existing row (and its attempt count) untouched.
export async function enqueuePendingAnnotation(input: {
  fundId: string;
  chainId: number;
  userOpHash: string;
  kind: string;
  note?: string | null;
}): Promise<void> {
  const userOpHash = input.userOpHash.toLowerCase();
  try {
    await prisma.pendingAnnotation.upsert({
      where: { fundId_userOpHash: { fundId: input.fundId, userOpHash } },
      create: {
        fundId: input.fundId,
        chainId: input.chainId,
        userOpHash,
        kind: input.kind,
        note: input.note ?? null,
      },
      update: {},
    });
  } catch (e) {
    console.warn("[annotation] enqueue failed", input.userOpHash, e);
  }
}

// The annotation entry point for any userOp-based tx. A userOp's settlement
// hash isn't final until `success` (a retry can change it), so we never
// annotate an eagerly-resolved hash. Check the bundler once: annotate now if
// already `success`, drop on `reverted`/`timeout`, otherwise queue and let the
// cron finish. Non-blocking — a single fast poll, then return.
export async function resolveOrEnqueueAnnotation(input: {
  fundId: string;
  chainId: number;
  userOpHash: string;
  kind: string;
  note?: string | null;
}): Promise<void> {
  let res;
  try {
    res = await getUserOpTx(input.chainId, input.userOpHash);
  } catch (e) {
    // Bundler unreachable right now — queue it; the cron will resolve later.
    console.warn("[annotation] immediate resolve failed; queueing", input.userOpHash, e);
    await enqueuePendingAnnotation(input);
    return;
  }

  if (res.status === "success" && res.txHash) {
    await annotateTransaction({
      fundId: input.fundId,
      txHash: res.txHash,
      kind: input.kind,
      note: input.note,
    });
  } else if (res.status === "reverted" || res.status === "timeout") {
    // The tx won't land — nothing to annotate.
    return;
  } else {
    await enqueuePendingAnnotation(input);
  }
}

export type ProcessResult = {
  checked: number;
  resolved: number;
  dropped: number;
  pending: number;
};

// Poll each queued userOp once. `success` → annotate the real tx hash + drop;
// `reverted` / `timeout` → drop (the tx won't land); otherwise keep, capping at
// MAX_ATTEMPTS so a stuck entry can't loop forever. Called by the cron.
export async function processPendingAnnotations(
  limit = 50,
): Promise<ProcessResult> {
  const rows = await prisma.pendingAnnotation.findMany({
    orderBy: { createdAt: "asc" },
    take: limit,
  });

  let resolved = 0;
  let dropped = 0;
  let pending = 0;

  for (const row of rows) {
    let res;
    try {
      res = await getUserOpTx(row.chainId, row.userOpHash);
    } catch (e) {
      console.warn("[annotation] resolve poll failed", row.userOpHash, e);
      if (await bumpOrDrop(row.id, row.attempts)) dropped++;
      else pending++;
      continue;
    }

    if (res.status === "success" && res.txHash) {
      await annotateTransaction({
        fundId: row.fundId,
        txHash: res.txHash,
        kind: row.kind,
        note: row.note,
      });
      await prisma.pendingAnnotation.delete({ where: { id: row.id } });
      resolved++;
    } else if (res.status === "reverted" || res.status === "timeout") {
      await prisma.pendingAnnotation.delete({ where: { id: row.id } });
      dropped++;
    } else {
      // pending | submitted (or success without a hash yet) — keep polling.
      if (await bumpOrDrop(row.id, row.attempts)) dropped++;
      else pending++;
    }
  }

  return { checked: rows.length, resolved, dropped, pending };
}

// Increment the attempt counter; drop the row once it hits the cap. Returns
// true when the row was dropped.
async function bumpOrDrop(id: string, attempts: number): Promise<boolean> {
  if (attempts + 1 >= MAX_ATTEMPTS) {
    await prisma.pendingAnnotation.delete({ where: { id } });
    return true;
  }
  await prisma.pendingAnnotation.update({
    where: { id },
    data: { attempts: { increment: 1 } },
  });
  return false;
}
