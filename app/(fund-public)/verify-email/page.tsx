// SPDX-License-Identifier: AGPL-3.0-or-later
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

import { prisma } from "@/services/db/prisma";
import {
  sendMemberWelcome,
  sendMerchantWelcome,
} from "@/services/email/transactional";
import { consumeVerificationToken } from "@/services/email/verification";
import { requireCurrentFund } from "@/services/fund/server";

// Token-consuming page. Refresh-safe: a token already consumed (e.g. by an
// email-scanner pre-fetch) shows the success page, not an error — we don't
// differentiate "verified just now" from "verified previously".
//
// Polymorphic over Member and Merchant: the verification row knows which
// entity it belongs to, we just dispatch the matching welcome email.

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const fund = await requireCurrentFund();
  const { token } = await searchParams;

  if (!token) redirect("/verify-email/error?reason=missing");

  const result = await consumeVerificationToken(token);

  if ("error" in result) {
    if (result.error === "consumed") {
      // Already-consumed tokens land on the in-app success page — we can't
      // tell which entity it belonged to, so we don't honor the configured
      // redirect URL on this branch.
      redirect("/verify-email/success");
    }
    redirect(`/verify-email/error?reason=${result.error}`);
  }

  // Verification succeeded — dispatch the welcome email idempotently. Any
  // exception (besides P2002 on the idempotency key) is logged but doesn't
  // affect the verification outcome.
  try {
    if (result.entity === "merchant") {
      await dispatchMerchantWelcome(fund, result.merchantId);
    } else {
      await dispatchMemberWelcome(fund, result.memberId);
    }
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code !== "P2002") {
      console.error("[verify-email] welcome dispatch failed", e);
    }
  }

  const successUrl =
    result.entity === "merchant"
      ? fund.merchantSignupSuccessUrl
      : fund.memberSignupSuccessUrl;
  redirect(successUrl ?? "/verify-email/success");
}

type FundContext = {
  id: string;
  name: string;
  primaryColor: string | null;
  logoUrl: string | null;
};

async function dispatchMerchantWelcome(
  fund: FundContext,
  merchantId: string,
) {
  const merchant = await prisma.merchant.findUnique({
    where: { id: merchantId },
    select: { id: true, email: true, name: true },
  });
  if (!merchant?.email) return;

  const t = await getTranslations("merchants.signup.email.welcome");
  const subject = t("subject", { fundName: fund.name });
  const emailRow = await prisma.email.create({
    data: {
      fundId: fund.id,
      type: "MERCHANT_WELCOME",
      toEmail: merchant.email,
      merchantId: merchant.id,
      idempotencyKey: `MERCHANT_WELCOME:merchant:${merchant.id}`,
      subject,
    },
  });
  await sendMerchantWelcome({
    emailId: emailRow.id,
    toEmail: merchant.email,
    fund: {
      name: fund.name,
      primaryColor: fund.primaryColor,
      logoUrl: fund.logoUrl,
    },
    merchantName: merchant.name,
  });
}

async function dispatchMemberWelcome(
  fund: FundContext,
  memberId: string,
) {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: {
      id: true,
      email: true,
      firstName: true,
      paymentReference: true,
    },
  });
  if (!member?.paymentReference) return;

  const t = await getTranslations("members.signup.emailTemplates.welcome");
  const subject = t("subject", { fundName: fund.name });
  const emailRow = await prisma.email.create({
    data: {
      fundId: fund.id,
      type: "MEMBER_WELCOME",
      toEmail: member.email,
      memberId: member.id,
      idempotencyKey: `MEMBER_WELCOME:member:${member.id}`,
      subject,
    },
  });
  await sendMemberWelcome({
    emailId: emailRow.id,
    toEmail: member.email,
    fund: {
      name: fund.name,
      primaryColor: fund.primaryColor,
      logoUrl: fund.logoUrl,
    },
    firstName: member.firstName,
    paymentReference: member.paymentReference,
  });
}
