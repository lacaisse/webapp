// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { isAPIError } from "better-auth/api";
import { getTranslations } from "next-intl/server";
import { headers } from "next/headers";

import { getApexUrl, getCurrentFund, getFundUrl } from "@/services/fund/server";

import { AttemptLimiter } from "./attempt-limiter";
import { auth } from "./better-auth";
import { requireUser } from "./dal";

// "Confirm your email address" on the fund dashboard: an account the apex
// /join door created starts unverified (nothing proved the inbox) and got one
// verification email; this sends it again. Better Auth's endpoint does the
// work (`emailVerification.sendVerificationEmail` in better-auth.ts) and,
// with a session, refuses an address that isn't the session's or is already
// verified. Server actions bypass its rate limiter, hence the per-user cap.

export type ResendVerificationResult = { ok: true } | { error: string };

// Three sends per account per hour.
const resendLimiter = new AttemptLimiter(3, 60 * 60_000);

export async function resendVerificationEmailAction(): Promise<ResendVerificationResult> {
  const user = await requireUser();
  if (user.emailVerified) return { ok: true };
  const t = await getTranslations("fund.dashboard.unverifiedEmail");
  if (!resendLimiter.allowed(user.id)) return { error: t("tooMany") };
  resendLimiter.fail(user.id);

  // The link comes back to where the person is: this fund's dashboard, or
  // the apex.
  const fund = await getCurrentFund();
  const callbackURL = fund ? `${getFundUrl(fund.domain)}/dashboard` : getApexUrl("/");
  try {
    await auth.api.sendVerificationEmail({
      body: { email: user.email, callbackURL },
      headers: await headers(),
    });
  } catch (e) {
    // The endpoint's refusals and the mail provider's failures alike.
    console.error("[auth] resend verification failed:", isAPIError(e) ? e.body : e);
    return { error: t("error") };
  }
  return { ok: true };
}
