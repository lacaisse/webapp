// SPDX-License-Identifier: AGPL-3.0-or-later
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getCurrentUser } from "@/services/auth/dal";
import { prisma } from "@/services/db/prisma";
import { dispatchMemberWelcomeSafe } from "@/services/email/member-welcome";
import { sendMerchantWelcome } from "@/services/email/transactional";
import {
  consumeVerificationToken,
  peekVerificationToken,
} from "@/services/email/verification";
import { getFundUrl, requireCurrentFund } from "@/services/fund/server";
import { ConfirmLoginVerification } from "./confirm-login-verification";

// Token-consuming page. Refresh-safe: a token already consumed (e.g. by an
// email-scanner pre-fetch) shows the success page, not an error — we don't
// differentiate "verified just now" from "verified previously".
//
// Polymorphic over Member and Merchant: the verification row knows which
// entity it belongs to, we just dispatch the matching welcome email.
//
// Member LOGIN tokens (services/member/auth.ts, `EmailVerification.userId`)
// are different: the click must prove ownership of that login, so the
// token is consumed by a POST (confirmMemberVerificationAction) from the
// signed-in user it was minted for — never on this GET, which a scanner
// pre-fetch or a link landing in the wrong inbox could trigger.

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const fund = await requireCurrentFund();
  const { token } = await searchParams;

  if (!token) redirect("/verify-email/error?reason=missing");

  const peek = await peekVerificationToken(token);
  if ("error" in peek) {
    // Already-consumed tokens land on the in-app success page — we can't
    // tell which entity it belonged to, so we don't honor the configured
    // redirect URL on this branch.
    if (peek.error === "consumed") redirect("/verify-email/success");
    redirect(`/verify-email/error?reason=${peek.error}`);
  }

  if (peek.userId) {
    if (!fund.memberLoginEnabled) redirect("/verify-email/error?reason=login_disabled");
    const user = await getCurrentUser();
    const here = `/verify-email?token=${encodeURIComponent(token)}`;
    if (!user) {
      redirect(`/login?return_to=${encodeURIComponent(here)}&notice=confirm_login`);
    }
    const t = await getTranslations("memberLogin.verify");
    if (user.id !== peek.userId) {
      // Someone else's session on this browser: no redirect loop through
      // /login (which would send a member straight back here) — sign out
      // and come back with the right login.
      return (
        <div className="w-full max-w-md">
          <Card>
            <CardHeader>
              <CardTitle>{t("title")}</CardTitle>
              <CardDescription>{t("wrongAccount", { email: user.email })}</CardDescription>
            </CardHeader>
            <CardContent>
              <form
                action={`/auth/logout?return_to=${encodeURIComponent(`${getFundUrl(fund.domain)}${here}`)}`}
                method="post"
              >
                <Button type="submit" variant="outline">
                  {t("signOut")}
                </Button>
              </form>
            </CardContent>
          </Card>
        </div>
      );
    }
    return (
      <div className="w-full max-w-md">
        <Card>
          <CardHeader>
            <CardTitle>{t("title")}</CardTitle>
            <CardDescription>{t("description", { fundName: fund.name })}</CardDescription>
          </CardHeader>
          <CardContent>
            <ConfirmLoginVerification token={token} />
          </CardContent>
        </Card>
      </div>
    );
  }

  const result = await consumeVerificationToken(token);

  if ("error" in result) {
    if (result.error === "consumed") redirect("/verify-email/success");
    redirect(`/verify-email/error?reason=${result.error}`);
  }

  // Verification succeeded — dispatch the welcome email idempotently. Any
  // exception (besides P2002 on the idempotency key) is logged but doesn't
  // affect the verification outcome.
  if (result.entity === "merchant") {
    try {
      await dispatchMerchantWelcome(fund, result.merchantId);
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code !== "P2002") console.error("[verify-email] welcome dispatch failed", e);
    }
  } else {
    await dispatchMemberWelcomeSafe(fund, result.memberId);
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
