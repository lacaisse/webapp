// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { refresh } from "next/cache";

import { requireFundRole } from "@/services/auth/dal";
import { prisma } from "@/services/db/prisma";

import { ANNOTATION_KINDS } from "./annotate";

export type AnnotateResult = { ok: true } | { error: string };

const TX_HASH = /^0x[a-fA-F0-9]{64}$/;
const NOTE_MAX = 280;

// Set or clear an operator's free-text note for a transaction. Upsert preserves
// any existing system `kind` (we only touch `note`); a blank note clears it. On
// a brand-new annotation the kind is CUSTOM. Scoped to the caller's fund.
export async function annotateTransactionAction(input: {
  txHash: string;
  note: string;
}): Promise<AnnotateResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const txHash = input.txHash.trim().toLowerCase();
  if (!TX_HASH.test(txHash)) {
    return { error: t("fund.annotations.errors.invalidHash" as never) };
  }
  const note = input.note.trim();
  if (note.length > NOTE_MAX) {
    return { error: t("fund.annotations.errors.noteTooLong" as never) };
  }

  try {
    await prisma.transactionAnnotation.upsert({
      where: { fundId_txHash: { fundId: fund.id, txHash } },
      create: { fundId: fund.id, txHash, kind: ANNOTATION_KINDS.custom, note: note || null },
      update: { note: note || null },
    });
  } catch (e) {
    console.error("[annotation] manual upsert failed", txHash, e);
    return { error: t("fund.annotations.errors.saveFailed" as never) };
  }

  // Re-render server views (token explorer, account detail first page). Client
  // tables also update their cell locally, so this is belt-and-braces.
  refresh();
  return { ok: true };
}
