// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { prisma } from "@/services/db/prisma";

// Per-fund transaction annotations, keyed by tx hash. `kind` is a machine
// category (resolved to a localised label in the UI); `note` is optional free
// text. Hashes are stored + looked up lowercased so writes (our tx hashes) and
// reads (Alchemy transfer hashes) always match.

export type TxAnnotation = {
  kind: string;
  note: string | null;
  // Mint/burn audit: what triggered the op (ANNOTATION_TRIGGERS) and the
  // display name of the acting admin (null for system/cron-driven ops).
  trigger: string | null;
  triggeredByName: string | null;
};

// Known system kinds. Free-form on the wire, but kept here so call sites don't
// drift and the UI knows which labels to provide.
export const ANNOTATION_KINDS = {
  payoutBurn: "PAYOUT_BURN",
  payoutFee: "PAYOUT_FEE",
  accountMint: "ACCOUNT_MINT",
  accountBurn: "ACCOUNT_BURN",
  accountTransfer: "ACCOUNT_TRANSFER",
  custom: "CUSTOM", // manual, operator-written annotation
} as const;

// What triggered a mint/burn — the "who or what" audit dimension. Free-form on
// the wire (a String column), centralised here so call sites don't drift and
// the UI knows which labels to localise. System/cron triggers (BANK_SYNC,
// PERIOD_CLOSE) carry a NULL triggeredByUserId; everything else carries the
// acting admin.
export const ANNOTATION_TRIGGERS = {
  adminManualMint: "ADMIN_MANUAL_MINT", // manual mint to a member's primary card
  adminDirectMint: "ADMIN_DIRECT_MINT", // ad-hoc mint to a raw address (/token)
  adminDirectBurn: "ADMIN_DIRECT_BURN", // ad-hoc burn from a raw address (/token)
  cardTopUp: "CARD_TOPUP",
  cardWithdrawal: "CARD_WITHDRAWAL",
  accountMint: "ACCOUNT_MINT",
  accountBurn: "ACCOUNT_BURN",
  accountTransfer: "ACCOUNT_TRANSFER",
  orderSettlementMint: "ORDER_SETTLEMENT_MINT", // credit a place when settling an order
  orderSettlementBurn: "ORDER_SETTLEMENT_BURN", // debit a payer when settling an order
  payoutBurn: "PAYOUT_BURN",
  payoutFee: "PAYOUT_FEE",
  referralReward: "REFERRAL_REWARD",
  bankSync: "BANK_SYNC", // cron: auto-mint on a matched deposit
  periodClose: "PERIOD_CLOSE", // cron: batch mint at period cutoff
} as const;

// Best-effort upsert — never throws, so it can't fail the action that produced
// the transaction. Idempotent on (fundId, txHash). `trigger` / `triggeredByUserId`
// are immutable audit fields: written on create, never overwritten by a later
// operator note edit (which omits them).
export async function annotateTransaction(input: {
  fundId: string;
  txHash: string;
  kind: string;
  note?: string | null;
  trigger?: string | null;
  triggeredByUserId?: string | null;
}): Promise<void> {
  const txHash = input.txHash.toLowerCase();
  try {
    await prisma.transactionAnnotation.upsert({
      where: { fundId_txHash: { fundId: input.fundId, txHash } },
      create: {
        fundId: input.fundId,
        txHash,
        kind: input.kind,
        note: input.note ?? null,
        trigger: input.trigger ?? null,
        triggeredByUserId: input.triggeredByUserId ?? null,
      },
      // Preserve the original audit trigger/actor on re-annotation; only refresh
      // the operator-facing kind/note. Backfill trigger/actor only if absent.
      update: {
        kind: input.kind,
        note: input.note ?? null,
        ...(input.trigger != null ? { trigger: input.trigger } : {}),
        ...(input.triggeredByUserId != null
          ? { triggeredByUserId: input.triggeredByUserId }
          : {}),
      },
    });
  } catch (e) {
    console.warn("[annotation] upsert failed", input.txHash, e);
  }
}

// Batch lookup → Map keyed by lowercased tx hash. Used by history views to
// enrich each row. Degrades to an empty map on error.
export async function getAnnotations(
  fundId: string,
  txHashes: string[],
): Promise<Map<string, TxAnnotation>> {
  const lowered = [...new Set(txHashes.map((h) => h.toLowerCase()))];
  if (lowered.length === 0) return new Map();
  try {
    const rows = await prisma.transactionAnnotation.findMany({
      where: { fundId, txHash: { in: lowered } },
      select: {
        txHash: true,
        kind: true,
        note: true,
        trigger: true,
        triggeredBy: { select: { name: true, email: true } },
      },
    });
    return new Map(
      rows.map((r) => [
        r.txHash,
        {
          kind: r.kind,
          note: r.note,
          trigger: r.trigger,
          triggeredByName: r.triggeredBy?.name ?? r.triggeredBy?.email ?? null,
        },
      ]),
    );
  } catch (e) {
    console.warn("[annotation] lookup failed", e);
    return new Map();
  }
}
