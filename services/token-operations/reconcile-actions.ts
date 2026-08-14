// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";

import { requireFundRole } from "@/services/auth/dal";
import { prisma } from "@/services/db/prisma";

import { reconcileOperation } from "./reconcile";

// Manual reconciliation of one token operation against the bundler (issue
// #162). See reconcile.ts for why this is needed at all: a TokenOperation
// reaches CONFIRMED without anything verifying the tokens landed, so
// "CONFIRMED" has meant "CitizenPay accepted the UserOp".
//
// This action never re-mints and never moves tokens. It only replaces our
// record of what happened with what the bundler says happened:
//
//   settled  → store the real settlement tx hash, mark CONFIRMED
//   pending  → change nothing, tell the admin to check again later
//   failed   → mark FAILED, which frees the member for a fresh mint
//   unknown  → change nothing (a flaky bundler must never look like failure)
//
// Marking FAILED is the only outcome that unblocks a re-mint, and it happens
// only on a terminal on-chain state (reverted / timeout) reported by the
// bundler — never on a transport error, and never on a timer.

export type ReconcileOperationResult =
  | { ok: true; outcome: "settled"; txHash: string }
  | { ok: true; outcome: "pending" }
  | { ok: true; outcome: "failed" }
  | { ok: true; outcome: "never-submitted" }
  | { error: string };

export async function reconcileOperationAction(input: {
  operationId: string;
}): Promise<ReconcileOperationResult> {
  const t = await getTranslations();
  // Token movement is ADMIN-only (OPERATOR manages cards and members).
  const { fund } = await requireFundRole("ADMIN");

  const op = await prisma.tokenOperation.findFirst({
    where: { id: input.operationId, fundId: fund.id },
    select: { id: true, txHash: true, status: true, memberId: true },
  });
  if (!op) return { error: t("token.reconcile.errors.notFound" as never) };

  // The chain the fund's token lives on — the bundler is chain-scoped.
  if (fund.tokenChainId == null) {
    return { error: t("token.reconcile.errors.noChain" as never) };
  }

  const outcome = await reconcileOperation({
    chainId: fund.tokenChainId,
    txHash: op.txHash,
  });

  switch (outcome.kind) {
    case "settled":
      await prisma.tokenOperation.update({
        where: { id: op.id },
        data: {
          // Replace the userOp hash with the real settlement hash, so the row
          // finally points at something the transfer history is keyed by.
          txHash: outcome.txHash,
          status: "CONFIRMED",
          confirmedAt: new Date(),
          errorMessage: null,
        },
      });
      break;

    case "failed":
      await prisma.tokenOperation.update({
        where: { id: op.id },
        data: {
          status: "FAILED",
          errorMessage: `Reconciled: bundler reported ${outcome.status}`,
        },
      });
      break;

    case "pending":
    case "never-submitted":
      // Nothing to write. `never-submitted` belongs to the mint-retry cron,
      // which only resubmits PENDING ops that never got a hash.
      break;

    case "unknown":
      console.warn("[token] reconcile inconclusive", op.id, outcome.reason);
      return { error: t("token.reconcile.errors.inconclusive" as never) };
  }

  revalidatePath("/token");
  if (op.memberId) revalidatePath(`/members/${op.memberId}`);

  if (outcome.kind === "settled") {
    return { ok: true, outcome: "settled", txHash: outcome.txHash };
  }
  if (outcome.kind === "failed") return { ok: true, outcome: "failed" };
  if (outcome.kind === "never-submitted") {
    return { ok: true, outcome: "never-submitted" };
  }
  return { ok: true, outcome: "pending" };
}
