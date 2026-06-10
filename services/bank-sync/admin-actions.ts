// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";

import { ensureOpenPeriod } from "@/services/allocation-periods/ensure";
import { requireFundRole } from "@/services/auth/dal";
import { prisma } from "@/services/db/prisma";
import { ANNOTATION_TRIGGERS } from "@/services/transaction-annotation/annotate";

import { mintTierAllocation } from "./allocate";
import { scoreNameMatch } from "./matching/name";

// Manual admin action: link an unmatched BankTransaction to a member when
// bank-sync couldn't auto-match (typo in payment reference, transfer from
// a different account, etc.). The lookup accepts either the member's
// paymentReference (uppercase) or email — whichever the admin has at hand.
//
// No retroactive minting in v1 — the row is just linked. If admins want to
// trigger a mint for the linked deposit, they'll need to do so manually via
// a TBD operation. PAY_AND_GO auto-mint is bank-sync-driven and only fires
// at ingest time, not on manual links.

export type LinkBankTransactionResult = { ok: true } | { error: string };

export async function linkBankTransactionAction(input: {
  bankTransactionId: string;
  identifier: string;
}): Promise<LinkBankTransactionResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const identifier = input.identifier.trim();
  if (!identifier) {
    return {
      error: t("fund.payments.admin.errors.identifierRequired" as never),
    };
  }

  const tx = await prisma.bankTransaction.findFirst({
    where: { id: input.bankTransactionId, fundId: fund.id },
    select: { id: true, direction: true, matchedAt: true },
  });
  if (!tx) {
    return { error: t("fund.payments.admin.errors.notFound" as never) };
  }
  if (tx.direction !== "INCOMING") {
    return { error: t("fund.payments.admin.errors.notIncoming" as never) };
  }

  // Look up by paymentReference (case-insensitive uppercase) OR email.
  const member = await prisma.member.findFirst({
    where: {
      fundId: fund.id,
      OR: [
        { paymentReference: identifier.toUpperCase() },
        { email: identifier.toLowerCase() },
      ],
    },
    select: { id: true },
  });
  if (!member) {
    return { error: t("fund.payments.admin.errors.memberNotFound" as never) };
  }

  await prisma.bankTransaction.update({
    where: { id: tx.id },
    data: { memberId: member.id, matchedAt: new Date() },
  });

  revalidatePath("/payments");
  return { ok: true };
}

export async function unlinkBankTransactionAction(input: {
  bankTransactionId: string;
}): Promise<LinkBankTransactionResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const tx = await prisma.bankTransaction.findFirst({
    where: { id: input.bankTransactionId, fundId: fund.id },
    select: { id: true },
  });
  if (!tx) {
    return { error: t("fund.payments.admin.errors.notFound" as never) };
  }

  await prisma.bankTransaction.update({
    where: { id: tx.id },
    data: { memberId: null, matchedAt: null, matchMethod: null, cardId: null },
  });

  revalidatePath("/payments");
  return { ok: true };
}

// Manually (re)assign an INCOMING deposit to an allocation period from the
// Bank screen. Data-only — no mint, no email; the period-close cron (or a
// manual close) is what turns period membership into mints. Blocked once the
// deposit has been used as a mint source: the mint already counted it in a
// period, so moving it would misreport history and risk double counting.
export async function setBankTransactionPeriodAction(input: {
  bankTransactionId: string;
  periodId: string | null;
}): Promise<LinkBankTransactionResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const tx = await prisma.bankTransaction.findFirst({
    where: { id: input.bankTransactionId, fundId: fund.id },
    select: {
      id: true,
      direction: true,
      _count: { select: { operationSources: true } },
    },
  });
  if (!tx) {
    return { error: t("fund.bank.periodAssign.errors.notFound" as never) };
  }
  if (tx.direction !== "INCOMING") {
    return { error: t("fund.bank.periodAssign.errors.notIncoming" as never) };
  }
  if (tx._count.operationSources > 0) {
    return { error: t("fund.bank.periodAssign.errors.locked" as never) };
  }

  if (input.periodId) {
    const period = await prisma.allocationPeriod.findFirst({
      where: { id: input.periodId, fundId: fund.id },
      select: { id: true },
    });
    if (!period) {
      return {
        error: t("fund.bank.periodAssign.errors.periodNotFound" as never),
      };
    }
  }

  await prisma.bankTransaction.update({
    where: { id: tx.id },
    data: { allocationPeriodId: input.periodId },
  });

  revalidatePath("/bank");
  return { ok: true };
}

// Ranked member suggestions for the manual attribution picker. With a query,
// filters by name/email; without one, ranks all members by name similarity to
// the deposit's counterpart name. Suggestions only — never an auto-match.
export type MemberSuggestion = {
  id: string;
  name: string;
  hasCardAccount: boolean;
  tierAssigned: boolean;
};

const memberPick = {
  id: true,
  firstName: true,
  lastName: true,
  tierId: true,
  primaryCard: { select: { account: true } },
} as const;

function toSuggestion(m: {
  id: string;
  firstName: string;
  lastName: string;
  tierId: string | null;
  primaryCard: { account: string | null } | null;
}): MemberSuggestion {
  return {
    id: m.id,
    name: `${m.firstName} ${m.lastName}`.trim(),
    hasCardAccount: Boolean(m.primaryCard?.account),
    tierAssigned: m.tierId !== null,
  };
}

export async function suggestMembersForAttributionAction(input: {
  bankTransactionId: string;
  query?: string;
}): Promise<MemberSuggestion[]> {
  const { fund } = await requireFundRole("ADMIN");
  const query = input.query?.trim() ?? "";

  if (query.length >= 2) {
    const members = await prisma.member.findMany({
      where: {
        fundId: fund.id,
        OR: [
          { firstName: { contains: query, mode: "insensitive" } },
          { lastName: { contains: query, mode: "insensitive" } },
          { email: { contains: query, mode: "insensitive" } },
        ],
      },
      select: memberPick,
      orderBy: [{ lastName: "asc" }, { firstName: "asc" }],
      take: 10,
    });
    return members.map(toSuggestion);
  }

  // No query → rank by name similarity to the deposit's counterpart name.
  const tx = await prisma.bankTransaction.findFirst({
    where: { id: input.bankTransactionId, fundId: fund.id },
    select: { counterpartName: true },
  });
  const members = await prisma.member.findMany({
    where: { fundId: fund.id },
    select: memberPick,
    take: 2000,
  });
  return members
    .map((m) => ({
      m,
      score: scoreNameMatch(tx?.counterpartName, m.firstName, m.lastName),
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((x) => toSuggestion(x.m));
}

// Attribute an unmatched INCOMING deposit to a member: link it (MANUAL), learn
// the IBAN for future auto-matching, and trigger the allocation — mint now for
// PAY_AND_GO (to the member's primary card), or tag the open period for
// FIXED_PERIOD so the close cron includes it. Shows up in allocation history.
export async function attributeBankTransactionAction(input: {
  bankTransactionId: string;
  memberId: string;
}): Promise<LinkBankTransactionResult> {
  const t = await getTranslations();
  const { user, fund } = await requireFundRole("ADMIN");

  const tx = await prisma.bankTransaction.findFirst({
    where: { id: input.bankTransactionId, fundId: fund.id },
    select: {
      id: true,
      direction: true,
      counterpartIban: true,
      amount: true,
      allocationPeriodId: true,
    },
  });
  if (!tx) {
    return { error: t("fund.payments.admin.errors.notFound" as never) };
  }
  if (tx.direction !== "INCOMING") {
    return { error: t("fund.payments.admin.errors.notIncoming" as never) };
  }

  const member = await prisma.member.findFirst({
    where: { id: input.memberId, fundId: fund.id },
    select: {
      id: true,
      tierId: true,
      primaryCard: { select: { account: true } },
    },
  });
  if (!member) {
    return { error: t("fund.payments.admin.errors.memberNotFound" as never) };
  }

  // FIXED_PERIOD: ensure the deposit is tagged to the current open period.
  let allocationPeriodId = tx.allocationPeriodId;
  if (fund.allocationMode === "FIXED_PERIOD" && !allocationPeriodId) {
    allocationPeriodId = await ensureOpenPeriod(
      fund.id,
      fund.allocationCutoffDay,
    );
  }

  await prisma.$transaction(async (db) => {
    await db.bankTransaction.update({
      where: { id: tx.id },
      data: {
        memberId: member.id,
        matchedAt: new Date(),
        matchMethod: "MANUAL",
        ...(allocationPeriodId ? { allocationPeriodId } : {}),
      },
    });
    // Learn the IBAN → member mapping so this account auto-matches next time.
    if (tx.counterpartIban) {
      await db.linkedBankAccount.upsert({
        where: { fundId_iban: { fundId: fund.id, iban: tx.counterpartIban } },
        create: {
          fundId: fund.id,
          iban: tx.counterpartIban,
          memberId: member.id,
          source: "MANUAL",
        },
        update: { memberId: member.id },
      });
    }
  });

  // PAY_AND_GO mints immediately (to the member's primary card — manual
  // attribution has no referenced card). FIXED_PERIOD mints at period close.
  if (fund.allocationMode === "PAY_AND_GO" && fund.citizenPayFundId) {
    await mintTierAllocation({
      fund: {
        id: fund.id,
        citizenPayFundId: fund.citizenPayFundId,
        citizenPayApiKeyId: fund.citizenPayApiKeyId,
        citizenPayApiKeyEnc: fund.citizenPayApiKeyEnc,
      },
      bankTransactionId: tx.id,
      memberId: member.id,
      tierId: member.tierId,
      account: member.primaryCard?.account ?? null,
      depositAmount: tx.amount.toString(),
      trigger: ANNOTATION_TRIGGERS.manualAttribution,
      triggeredByUserId: user.id,
    });
  }

  revalidatePath("/payments");
  return { ok: true };
}
