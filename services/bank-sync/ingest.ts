import "server-only";

import { Prisma } from "@/services/db/generated/client";

import { getCitizenPayClient } from "@/services/citizenpay/client";
import type { BankTransactionPayload } from "@/services/citizenpay/types";
import { prisma } from "@/services/db/prisma";
import { sendPaymentConfirmation } from "@/services/email/transactional";

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

type IngestStats = {
  ingested: number;
  matched: number;
  minted: number;
  skipped: number;
};

type IngestionFund = {
  id: string;
  citizenPayFundId: string;
  citizenPayLastSyncedAt: Date | null;
  allocationMode: "FIXED_PERIOD" | "PAY_AND_GO";
  name: string;
};

export async function syncFundBankTransactions(
  fund: IngestionFund,
): Promise<IngestStats> {
  const cp = getCitizenPayClient();
  const stats: IngestStats = { ingested: 0, matched: 0, minted: 0, skipped: 0 };

  const result = await cp.listBankTransactions({
    fundCitizenPayId: fund.citizenPayFundId,
    since: fund.citizenPayLastSyncedAt?.toISOString(),
  });

  for (const payload of result.transactions) {
    try {
      const r = await ingestOne(fund, payload);
      if (r === "skipped") stats.skipped++;
      else {
        stats.ingested++;
        if (r.matched) stats.matched++;
        if (r.minted) stats.minted++;
      }
    } catch (e) {
      console.error("[bank-sync] ingest failed", payload.externalId, e);
      // Continue with the rest of the batch — one bad payload shouldn't
      // halt sync. (fundId, externalId) uniqueness means rerun is safe.
    }
  }

  await prisma.fund.update({
    where: { id: fund.id },
    data: { citizenPayLastSyncedAt: new Date() },
  });

  return stats;
}

type IngestOneResult = "skipped" | { matched: boolean; minted: boolean };

async function ingestOne(
  fund: IngestionFund,
  payload: BankTransactionPayload,
): Promise<IngestOneResult> {
  const existing = await prisma.bankTransaction.findUnique({
    where: {
      fundId_externalId: { fundId: fund.id, externalId: payload.externalId },
    },
    select: { id: true, matchedAt: true },
  });
  // Already ingested + already matched — nothing to do. Re-match logic for
  // previously-unmatched rows isn't run here because the cron only pulls
  // "new since cursor"; if a member registers later, admin can manually
  // link via the UI (TBD).
  if (existing?.matchedAt) return "skipped";

  // For the OUTGOING direction (merchant payouts), we just mirror — no
  // member matching, no minting. Match-to-merchant comes when we wire
  // the payout review UI.
  if (payload.direction === "OUTGOING") {
    if (existing) return "skipped";
    await createBankTransaction(fund.id, payload, null);
    return { matched: false, minted: false };
  }

  // INCOMING: ingest + try to match.
  const match = await matchMember(fund.id, payload);
  const allocationPeriodId =
    fund.allocationMode === "FIXED_PERIOD"
      ? await currentOpenPeriodId(fund.id)
      : null;

  if (!existing) {
    await createBankTransaction(fund.id, payload, match, allocationPeriodId);
  } else if (match) {
    await prisma.bankTransaction.update({
      where: { id: existing.id },
      data: {
        memberId: match.memberId,
        matchedAt: new Date(),
        ...(allocationPeriodId ? { allocationPeriodId } : {}),
      },
    });
  } else {
    return { matched: false, minted: false };
  }

  if (!match) return { matched: false, minted: false };

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

type Match = {
  memberId: string;
  tierId: string | null;
  account: string | null;
};

async function matchMember(
  fundId: string,
  payload: BankTransactionPayload,
): Promise<Match | null> {
  const candidates: string[] = [];
  if (payload.counterpartReference) {
    candidates.push(payload.counterpartReference.trim().toUpperCase());
  }
  if (payload.remittanceInfo) {
    for (const token of payload.remittanceInfo.toUpperCase().split(/[^A-Z0-9]+/)) {
      if (token.length >= 6 && token.length <= 16) candidates.push(token);
    }
  }

  if (candidates.length > 0) {
    const m = await prisma.member.findFirst({
      where: { fundId, paymentReference: { in: candidates } },
      select: {
        id: true,
        tierId: true,
        primaryCard: { select: { account: true } },
      },
    });
    if (m) {
      return {
        memberId: m.id,
        tierId: m.tierId,
        account: m.primaryCard?.account ?? null,
      };
    }
  }

  if (payload.counterpartIban) {
    const m = await prisma.member.findFirst({
      where: { fundId, iban: payload.counterpartIban },
      select: {
        id: true,
        tierId: true,
        primaryCard: { select: { account: true } },
      },
    });
    if (m) {
      return {
        memberId: m.id,
        tierId: m.tierId,
        account: m.primaryCard?.account ?? null,
      };
    }
  }

  return null;
}

async function currentOpenPeriodId(fundId: string): Promise<string | null> {
  const period = await prisma.allocationPeriod.findFirst({
    where: { fundId, status: "OPEN" },
    orderBy: { startsAt: "desc" },
    select: { id: true },
  });
  return period?.id ?? null;
}

async function dispatchPaymentConfirmation(args: {
  fund: IngestionFund;
  bankTransactionId: string;
  member: Match;
  amount: string;
  occurredAt: string;
}): Promise<void> {
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
      fundName: args.fund.name,
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

async function tryMintForPayAndGo(args: {
  fund: IngestionFund;
  bankTransactionId: string;
  memberId: string;
  tierId: string | null;
  account: string | null;
  depositAmount: string;
}): Promise<boolean> {
  if (!args.tierId) return false; // no tier assigned → no auto-mint
  if (!args.account) return false; // member has no primary card account

  const tier = await prisma.allocationTier.findUnique({
    where: { id: args.tierId },
    select: {
      minContribution: true,
      maxContribution: true,
      allocationAmount: true,
    },
  });
  if (!tier) return false;

  const deposit = new Prisma.Decimal(args.depositAmount);
  if (deposit.lt(tier.minContribution) || deposit.gt(tier.maxContribution)) {
    return false; // out of range — admin can review manually
  }

  // Create op + source link in a transaction. Submission to CP happens
  // outside (HTTP latency shouldn't hold locks).
  const op = await prisma.$transaction(async (tx) => {
    const op = await tx.tokenOperation.create({
      data: {
        fundId: args.fund.id,
        type: "MINT",
        memberId: args.memberId,
        account: args.account!,
        amount: tier.allocationAmount,
        tierId: args.tierId,
        status: "PENDING",
      },
    });
    await tx.tokenOperationSource.create({
      data: {
        bankTransactionId: args.bankTransactionId,
        tokenOperationId: op.id,
      },
    });
    return op;
  });

  try {
    const cp = getCitizenPayClient();
    const submitted = await cp.submitMint({
      fundCitizenPayId: args.fund.citizenPayFundId,
      toAccount: args.account,
      amount: tier.allocationAmount.toString(),
      reference: op.id,
    });
    await prisma.tokenOperation.update({
      where: { id: op.id },
      data: { txHash: submitted.txHash },
    });
  } catch (e) {
    console.error("[bank-sync] submitMint failed", op.id, e);
    // Op stays PENDING with no txHash; not picked up by the status-polling
    // cron until a re-submit job exists.
  }

  return true;
}
