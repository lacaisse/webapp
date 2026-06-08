// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { prisma } from "@/services/db/prisma";

// Per-fund transaction annotations, keyed by tx hash. `kind` is a machine
// category (resolved to a localised label in the UI); `note` is optional free
// text. Hashes are stored + looked up lowercased so writes (our tx hashes) and
// reads (Alchemy transfer hashes) always match.

export type TxAnnotation = { kind: string; note: string | null };

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

// Best-effort upsert — never throws, so it can't fail the action that produced
// the transaction. Idempotent on (fundId, txHash).
export async function annotateTransaction(input: {
  fundId: string;
  txHash: string;
  kind: string;
  note?: string | null;
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
      },
      update: { kind: input.kind, note: input.note ?? null },
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
      select: { txHash: true, kind: true, note: true },
    });
    return new Map(rows.map((r) => [r.txHash, { kind: r.kind, note: r.note }]));
  } catch (e) {
    console.warn("[annotation] lookup failed", e);
    return new Map();
  }
}
