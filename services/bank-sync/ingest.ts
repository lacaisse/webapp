// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { Prisma } from "@/services/db/generated/client";

import {
  ensureOpenPeriod,
  ensurePeriodForDate,
} from "@/services/allocation-periods/ensure";
import { getCitizenPayClient } from "@/services/citizenpay/client";
import type { BankTransactionPayload } from "@/services/citizenpay/types";

import { mintTierAllocation } from "./allocate";
import { matchMember, type Match } from "./matching/match";
import { prisma } from "@/services/db/prisma";
import { sendPaymentConfirmation } from "@/services/email/transactional";
import { ANNOTATION_TRIGGERS } from "@/services/transaction-annotation/annotate";

// Bank-sync ingestion. Mirrors CitizenPay-reported bank movements into the
// local BankTransaction table, attempts to match each INCOMING row to a
// member (paymentReference → remittance info → IBAN), and, for funds in
// PAY_AND_GO mode, triggers a mint at the matched member's tier amount.
//
// Idempotency: BankTransaction has @@unique([fundId, externalId]). If a
// cron re-run encounters the same payload, the upsert short-circuits and
// we skip side effects (match + mint + email).
//
// PAY_AND_GO vs FIXED_PERIOD: FIXED_PERIOD funds just record + tag the
// transaction with the current open AllocationPeriod (if any). The period
// close cron is responsible for batch minting.
//
// Two behaviors share this module:
// - "automated" (cron): full side effects — match, confirmation email, and
//   PAY_AND_GO mint. Deposits attach to the fund's current open period.
// - "backfill" (manual full sync): mirror + match ONLY. No emails, no mints.
//   FIXED_PERIOD deposits are back-allocated to the period their own
//   occurredAt falls in; already-past months are created CLOSED so the
//   period-close cron never batch-mints a backfilled period.

export type IngestStats = {
  ingested: number;
  matched: number;
  minted: number;
  skipped: number;
};

type IngestionFund = {
  id: string;
  citizenPayFundId: string;
  citizenPayApiKeyId: string | null;
  citizenPayApiKeyEnc: string | null;
  citizenPayLastSyncedAt: Date | null;
  allocationMode: "FIXED_PERIOD" | "PAY_AND_GO" | "DISABLED";
  allocationCutoffDay: number;
  confirmationEmailsPausedAt: Date | null;
  name: string;
  primaryColor: string | null;
  logoUrl: string | null;
};

// Bank transactions can appear in the Ponto feed days after their
// executionDate (our `occurredAt`), and the paging watermark compares against
// occurredAt — without an overlap, a row that settles late reads as "already
// synced" and is dropped forever. Re-scanning a window behind the last sync is
// free: the (fundId, externalId) upsert skips rows we already have.
const WATERMARK_OVERLAP_MS = 7 * 24 * 60 * 60 * 1000;

// Cron path: incremental sync since the fund's last-sync watermark.
export async function syncFundBankTransactions(
  fund: IngestionFund,
): Promise<IngestStats> {
  const cp = getCitizenPayClient(fund);

  const result = await cp.listBankTransactions({
    fundCitizenPayId: fund.citizenPayFundId,
    since: fund.citizenPayLastSyncedAt
      ? new Date(
          fund.citizenPayLastSyncedAt.getTime() - WATERMARK_OVERLAP_MS,
        ).toISOString()
      : undefined,
  });

  const stats = await ingestPayloads(fund, result.transactions, "automated");
  await touchLastSyncedAt(fund.id);
  return stats;
}

type IngestBehavior = "automated" | "backfill";

// Manual full-sync, one page at a time. The Bank page drives this in a loop
// (passing back `nextCursor`) so each request stays short and progress is
// visible. We ignore the watermark — this re-pulls the full history — and only
// bump `citizenPayLastSyncedAt` on the final page so a mid-run abort leaves the
// cron's watermark untouched. Idempotent on (fundId, externalId), so a resumed
// or restarted run just skips rows it already ingested. Runs with "backfill"
// behavior: no emails, no mints — see the module header.
export async function runFullBankSyncPage(
  fund: IngestionFund,
  cursor?: string,
): Promise<{ stats: IngestStats; nextCursor: string | null; done: boolean }> {
  const cp = getCitizenPayClient(fund);
  // 25 (not 100) per chunk: rows are ingested sequentially (matching +
  // period lookups), so a smaller page keeps each action short and the UI's
  // page counter ticking.
  const page = await cp.getBankTransactionPayloadPage({ limit: 25, cursor });
  const stats = await ingestPayloads(fund, page.transactions, "backfill");
  // End of history when CP gives no next cursor, or returns an empty page even
  // with a (stale) cursor still present — there's nothing left to ingest.
  const done = !page.nextCursor || page.fetched === 0;
  if (done) await touchLastSyncedAt(fund.id);
  return { stats, nextCursor: done ? null : page.nextCursor, done };
}

// Ingest one batch of payloads. One bad payload is logged and skipped — it
// shouldn't halt the batch, and (fundId, externalId) uniqueness makes a rerun
// safe.
async function ingestPayloads(
  fund: IngestionFund,
  payloads: BankTransactionPayload[],
  behavior: IngestBehavior,
): Promise<IngestStats> {
  const stats: IngestStats = { ingested: 0, matched: 0, minted: 0, skipped: 0 };
  for (const payload of payloads) {
    try {
      const r = await ingestOne(fund, payload, behavior);
      if (r === "skipped") stats.skipped++;
      else {
        stats.ingested++;
        if (r.matched) stats.matched++;
        if (r.minted) stats.minted++;
      }
    } catch (e) {
      console.error("[bank-sync] ingest failed", payload.externalId, e);
    }
  }
  return stats;
}

function touchLastSyncedAt(fundId: string): Promise<unknown> {
  return prisma.fund.update({
    where: { id: fundId },
    data: { citizenPayLastSyncedAt: new Date() },
  });
}

type IngestOneResult = "skipped" | { matched: boolean; minted: boolean };

// The allocation period an INCOMING deposit attaches to. Live ingest uses the
// fund's current open period; backfill uses the period the deposit's own
// occurredAt falls in (past months back-created CLOSED).
function resolveAllocationPeriod(
  fund: IngestionFund,
  payload: BankTransactionPayload,
  behavior: IngestBehavior,
): Promise<string | null> {
  if (fund.allocationMode !== "FIXED_PERIOD") return Promise.resolve(null);
  return behavior === "backfill"
    ? ensurePeriodForDate(
        fund.id,
        fund.allocationCutoffDay,
        new Date(payload.occurredAt),
      )
    : ensureOpenPeriod(fund.id, fund.allocationCutoffDay);
}

async function ingestOne(
  fund: IngestionFund,
  payload: BankTransactionPayload,
  behavior: IngestBehavior,
): Promise<IngestOneResult> {
  const existing = await prisma.bankTransaction.findUnique({
    where: {
      fundId_externalId: { fundId: fund.id, externalId: payload.externalId },
    },
    select: { id: true, matchedAt: true, allocationPeriodId: true },
  });
  // Already ingested + already matched — nothing to do. Re-match logic for
  // previously-unmatched rows isn't run here because the cron only pulls
  // "new since cursor"; if a member registers later, admin can manually
  // link via the UI (TBD).
  if (existing?.matchedAt) {
    // Backfill repair: a matched row can still lack its allocation period
    // (ingested while the fund was in another mode, or before periods
    // existed). Attaching it is data-only — no emails, no mints.
    if (
      behavior === "backfill" &&
      payload.direction === "INCOMING" &&
      !existing.allocationPeriodId
    ) {
      const periodId = await resolveAllocationPeriod(fund, payload, behavior);
      if (periodId) {
        await prisma.bankTransaction.update({
          where: { id: existing.id },
          data: { allocationPeriodId: periodId },
        });
      }
    }
    return "skipped";
  }

  // For the OUTGOING direction (merchant payouts), we just mirror — no
  // member matching, no minting. Match-to-merchant comes when we wire
  // the payout review UI.
  if (payload.direction === "OUTGOING") {
    if (existing) return "skipped";
    await createBankTransaction(fund.id, payload, null);
    return { matched: false, minted: false };
  }

  // INCOMING: ingest + try to match. FIXED_PERIOD rows get tagged with their
  // allocation period (created on demand — see resolveAllocationPeriod).
  // PAY_AND_GO funds don't use periods.
  const match = await matchMember(fund.id, payload);
  const allocationPeriodId = await resolveAllocationPeriod(
    fund,
    payload,
    behavior,
  );

  if (!existing) {
    await createBankTransaction(fund.id, payload, match, allocationPeriodId);
  } else {
    // Existing unmatched row: apply a found match. Backfill additionally fills
    // a missing period (never overwrites one — a row already attached may have
    // been minted in that period).
    const fillPeriod =
      behavior === "backfill" &&
      !existing.allocationPeriodId &&
      allocationPeriodId !== null;
    if (!match && !fillPeriod) return { matched: false, minted: false };
    await prisma.bankTransaction.update({
      where: { id: existing.id },
      data: {
        ...(match
          ? {
              memberId: match.memberId,
              matchedAt: new Date(),
              matchMethod: match.method,
              cardId: match.cardId,
            }
          : {}),
        ...(behavior === "backfill"
          ? fillPeriod
            ? { allocationPeriodId }
            : {}
          : allocationPeriodId
            ? { allocationPeriodId }
            : {}),
      },
    });
  }

  if (!match) return { matched: false, minted: false };

  // Manual full sync mirrors and back-allocates only — confirmation emails
  // and PAY_AND_GO mints stay with the live cron.
  if (behavior === "backfill") return { matched: true, minted: false };

  const bankTransactionId = existing?.id ?? (await getBankTransactionId(fund.id, payload.externalId));
  if (!bankTransactionId) return { matched: true, minted: false };

  // Queue + send payment confirmation regardless of allocation mode.
  await dispatchPaymentConfirmation({
    fund,
    bankTransactionId,
    member: match,
    amount: payload.amount,
    occurredAt: payload.occurredAt,
  });

  // Minting: PAY_AND_GO only. FIXED_PERIOD accumulates until period close.
  let minted = false;
  if (fund.allocationMode === "PAY_AND_GO") {
    minted = await tryMintForPayAndGo({
      fund,
      bankTransactionId,
      memberId: match.memberId,
      tierId: match.tierId,
      account: match.account,
      depositAmount: payload.amount,
    });
  }

  return { matched: true, minted };
}

async function createBankTransaction(
  fundId: string,
  payload: BankTransactionPayload,
  match: Match | null,
  allocationPeriodId: string | null = null,
): Promise<void> {
  await prisma.bankTransaction.create({
    data: {
      fundId,
      externalId: payload.externalId,
      direction: payload.direction,
      amount: payload.amount,
      currency: payload.currency,
      occurredAt: new Date(payload.occurredAt),
      counterpartName: payload.counterpartName ?? null,
      counterpartIban: payload.counterpartIban ?? null,
      counterpartReference: payload.counterpartReference ?? null,
      remittanceInfo: payload.remittanceInfo ?? null,
      rawData: payload.rawData
        ? (payload.rawData as Prisma.InputJsonValue)
        : undefined,
      memberId: match?.memberId ?? null,
      matchedAt: match ? new Date() : null,
      matchMethod: match?.method ?? null,
      cardId: match?.cardId ?? null,
      allocationPeriodId: allocationPeriodId ?? null,
    },
  });
}

async function getBankTransactionId(
  fundId: string,
  externalId: string,
): Promise<string | null> {
  const row = await prisma.bankTransaction.findUnique({
    where: { fundId_externalId: { fundId, externalId } },
    select: { id: true },
  });
  return row?.id ?? null;
}

async function dispatchPaymentConfirmation(args: {
  fund: IngestionFund;
  bankTransactionId: string;
  member: Match;
  amount: string;
  occurredAt: string;
}): Promise<void> {
  // Fund-level pause: skip entirely (no Email row) — resuming doesn't send
  // skipped confirmations retroactively.
  if (args.fund.confirmationEmailsPausedAt) return;

  // Look up member email + name. We could pass these from the matcher but
  // re-querying is simpler and the row is small.
  const member = await prisma.member.findUnique({
    where: { id: args.member.memberId },
    select: { email: true, firstName: true },
  });
  if (!member) return;

  try {
    const emailRow = await prisma.email.create({
      data: {
        fundId: args.fund.id,
        type: "PAYMENT_CONFIRMATION",
        toEmail: member.email,
        memberId: args.member.memberId,
        bankTransactionId: args.bankTransactionId,
        idempotencyKey: `PAYMENT_CONFIRMATION:bankTransaction:${args.bankTransactionId}`,
        subject: "Payment received",
      },
    });
    await sendPaymentConfirmation({
      emailId: emailRow.id,
      toEmail: member.email,
      firstName: member.firstName,
      fund: {
        name: args.fund.name,
        primaryColor: args.fund.primaryColor,
        logoUrl: args.fund.logoUrl,
      },
      amount: args.amount,
      occurredAt: args.occurredAt,
    });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code !== "P2002") {
      console.error("[bank-sync] payment confirmation queue/send failed", e);
    }
  }
}

function tryMintForPayAndGo(args: {
  fund: IngestionFund;
  bankTransactionId: string;
  memberId: string;
  tierId: string | null;
  account: string | null;
  depositAmount: string;
}): Promise<boolean> {
  // System-triggered mint (cron) — no acting admin. The shared allocator does
  // the tier range-check, op + source-link, CP submit, and annotation.
  return mintTierAllocation({
    fund: args.fund,
    bankTransactionId: args.bankTransactionId,
    memberId: args.memberId,
    tierId: args.tierId,
    account: args.account,
    depositAmount: args.depositAmount,
    trigger: ANNOTATION_TRIGGERS.bankSync,
    triggeredByUserId: null,
  });
}
