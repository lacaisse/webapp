// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";

import { requireFundRole } from "@/services/auth/dal";
import { prisma } from "@/services/db/prisma";

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
    data: { memberId: null, matchedAt: null },
  });

  revalidatePath("/payments");
  return { ok: true };
}
