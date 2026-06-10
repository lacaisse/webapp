// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";

import { requireFundRole } from "@/services/auth/dal";
import {
  runFullBankSyncPage,
  type IngestStats,
} from "@/services/bank-sync/ingest";

// Manual full bank-sync, one page per call. The Bank page calls this in a loop,
// passing back `nextCursor` until `done`, so progress can be shown without a
// single long-running request. Re-pulls the full history and is idempotent, so
// a restart or resume is safe.
export type FullBankSyncChunkResult =
  | { error: string }
  | {
      ok: true;
      stats: IngestStats;
      nextCursor: string | null;
      done: boolean;
    };

export async function runFullBankSyncChunkAction(input: {
  cursor?: string;
}): Promise<FullBankSyncChunkResult> {
  const t = await getTranslations("fund.bank.fullSync");
  const { fund } = await requireFundRole("ADMIN");

  if (!fund.citizenPayFundId) {
    return { error: t("notConnected") };
  }

  try {
    const { stats, nextCursor, done } = await runFullBankSyncPage(
      {
        id: fund.id,
        name: fund.name,
        citizenPayFundId: fund.citizenPayFundId,
        citizenPayApiKeyId: fund.citizenPayApiKeyId,
        citizenPayApiKeyEnc: fund.citizenPayApiKeyEnc,
        citizenPayLastSyncedAt: fund.citizenPayLastSyncedAt,
        allocationMode: fund.allocationMode,
        allocationCutoffDay: fund.allocationCutoffDay,
        confirmationEmailsPausedAt: fund.confirmationEmailsPausedAt,
        primaryColor: fund.primaryColor,
        logoUrl: fund.logoUrl,
      },
      input.cursor,
    );
    return { ok: true, stats, nextCursor, done };
  } catch (e) {
    console.error("[bank] runFullBankSync failed", e);
    return { error: t("error") };
  }
}
