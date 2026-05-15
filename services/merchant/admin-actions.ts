// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";

import { requireFundRole } from "@/services/auth/dal";
import { prisma } from "@/services/db/prisma";
import {
  sendMerchantApproved,
  sendMerchantRejected,
} from "@/services/email/transactional";

export type ReviewMerchantResult = { ok: true } | { error: string };

export async function approveMerchantAction(input: {
  merchantId: string;
  note?: string;
}): Promise<ReviewMerchantResult> {
  const t = await getTranslations();
  const { user, fund } = await requireFundRole("ADMIN");

  const merchant = await prisma.merchant.findFirst({
    where: { id: input.merchantId, fundId: fund.id },
    select: { id: true, email: true, name: true, status: true },
  });
  if (!merchant) return { error: t("merchants.admin.errors.notFound" as never) };
  if (merchant.status === "ACTIVE") {
    return { error: t("merchants.admin.errors.alreadyApproved" as never) };
  }

  // Per-fund subject + idempotency. Approval can happen after a prior REJECT
  // (REJECTED is reconsiderable), so we key the email by merchant + a
  // monotonic counter would be ideal — but for v1, merchant-id-keyed is fine
  // since the typical case is one approval per merchant lifetime.
  const subject = t("merchants.admin.email.approved.subject" as never, {
    fundName: fund.name,
  } as never);

  const onboardingUrl = process.env.CITIZENPAY_MERCHANT_ONBOARDING_URL || null;

  const emailRow = await prisma.$transaction(async (tx) => {
    await tx.merchant.update({
      where: { id: merchant.id },
      data: {
        status: "ACTIVE",
        reviewedAt: new Date(),
        reviewerId: user.id,
        reviewNote: input.note?.trim() || null,
      },
    });
    return tx.email.create({
      data: {
        fundId: fund.id,
        type: "MERCHANT_APPROVED",
        toEmail: merchant.email!,
        merchantId: merchant.id,
        idempotencyKey: `MERCHANT_APPROVED:merchant:${merchant.id}`,
        subject,
      },
    });
  });

  await sendMerchantApproved({
    emailId: emailRow.id,
    toEmail: merchant.email!,
    fund: {
      name: fund.name,
      primaryColor: fund.primaryColor,
      logoUrl: fund.logoUrl,
    },
    merchantName: merchant.name,
    citizenPayOnboardingUrl: onboardingUrl,
  });

  revalidatePath("/merchants");
  return { ok: true };
}

export async function reconsiderMerchantAction(input: {
  merchantId: string;
}): Promise<ReviewMerchantResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const merchant = await prisma.merchant.findFirst({
    where: { id: input.merchantId, fundId: fund.id },
    select: { id: true, status: true },
  });
  if (!merchant) return { error: t("merchants.admin.errors.notFound" as never) };
  if (merchant.status !== "REJECTED") {
    return { error: t("merchants.admin.errors.notRejected" as never) };
  }

  await prisma.merchant.update({
    where: { id: merchant.id },
    data: {
      status: "PENDING",
      reviewedAt: null,
      reviewerId: null,
      reviewNote: null,
    },
  });

  revalidatePath("/merchants");
  return { ok: true };
}

export async function rejectMerchantAction(input: {
  merchantId: string;
  note: string;
}): Promise<ReviewMerchantResult> {
  const t = await getTranslations();
  const { user, fund } = await requireFundRole("ADMIN");

  const reason = input.note.trim();
  if (!reason) {
    return { error: t("merchants.admin.errors.reasonRequired" as never) };
  }

  const merchant = await prisma.merchant.findFirst({
    where: { id: input.merchantId, fundId: fund.id },
    select: { id: true, email: true, name: true, status: true },
  });
  if (!merchant) return { error: t("merchants.admin.errors.notFound" as never) };
  if (merchant.status === "REJECTED") {
    return { error: t("merchants.admin.errors.alreadyRejected" as never) };
  }

  const subject = t("merchants.admin.email.rejected.subject" as never, {
    fundName: fund.name,
  } as never);

  const emailRow = await prisma.$transaction(async (tx) => {
    await tx.merchant.update({
      where: { id: merchant.id },
      data: {
        status: "REJECTED",
        reviewedAt: new Date(),
        reviewerId: user.id,
        reviewNote: reason,
      },
    });
    return tx.email.create({
      data: {
        fundId: fund.id,
        type: "MERCHANT_REJECTED",
        toEmail: merchant.email!,
        merchantId: merchant.id,
        idempotencyKey: `MERCHANT_REJECTED:merchant:${merchant.id}`,
        subject,
      },
    });
  });

  await sendMerchantRejected({
    emailId: emailRow.id,
    toEmail: merchant.email!,
    fund: {
      name: fund.name,
      primaryColor: fund.primaryColor,
      logoUrl: fund.logoUrl,
    },
    merchantName: merchant.name,
    reason,
  });

  revalidatePath("/merchants");
  return { ok: true };
}
