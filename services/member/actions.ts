// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getLocale, getTranslations } from "next-intl/server";
import { prisma } from "@/services/db/prisma";
import {
  sendMemberEmailVerification,
  sendMemberWelcome,
} from "@/services/email/transactional";
import {
  generateVerificationToken,
  verificationExpiry,
} from "@/services/email/verification";
import { getFundUrl, requireCurrentFund } from "@/services/fund/server";
import { generatePaymentReference } from "./payment-reference";
import {
  BuiltinSignupSchema,
  type BuiltinSignupInput,
  type ExtraValue,
} from "./schema";
import { isUniqueViolationOn, resolveMemberSignup } from "./signup-core";

// `redirectTo` on the error variant is set only for TERMINAL failures — the
// ones the visitor can do nothing about. Errors they can fix (a taken email, a
// missing required answer) stay inline in the form: bouncing someone off to an
// external error page over a typo would lose everything they typed.
export type SignupMemberResult =
  | {
      error: string;
      field?: "firstName" | "lastName" | "email" | "contributionAmount";
      redirectTo?: string;
    }
  | { ok: true; redirectTo: string };

const MAX_REFERENCE_RETRIES = 5;

// Append our failure marker to the fund's configured error URL, preserving any
// query string it already carries. A malformed stored URL yields null so the
// caller falls back to showing the error inline.
function errorRedirect(errorUrl: string | null, code: string): string | undefined {
  if (!errorUrl) return undefined;
  try {
    const url = new URL(errorUrl);
    url.searchParams.set("error", code);
    return url.toString();
  } catch {
    return undefined;
  }
}

export async function signupMemberAction(input: {
  builtins: BuiltinSignupInput;
  applicationData?: Record<string, ExtraValue>;
  referralCode?: string | null;
}): Promise<SignupMemberResult> {
  const t = await getTranslations();

  const parsed = BuiltinSignupSchema.safeParse(input.builtins);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      error: t(issue.message as never),
      field: issue.path[0] as "firstName" | "lastName" | "email" | undefined,
    };
  }

  const fund = await requireCurrentFund();

  // The member's preferred language = the locale they're registering in, so
  // every follow-up email matches it. Falls back to the fund default in the
  // email layer if this is ever null.
  const locale = await getLocale();

  // The parts shared with the member LOGIN sign-up (/signup): commitment
  // amount gate, OnboardingFields, referral code — services/member/signup-core.ts.
  const resolution = await resolveMemberSignup({
    fund,
    builtins: parsed.data,
    applicationData: input.applicationData,
    referralCode: input.referralCode,
    t: (key, values) => t(key as never, values as never),
  });
  if (!resolution.ok) {
    return resolution.field
      ? { error: resolution.error, field: resolution.field }
      : { error: resolution.error };
  }
  const { contributionAmount, builtinColumns, applicationData, sponsor } =
    resolution.resolved;

  const requireVerify = fund.requireMemberEmailVerification;

  // Note: signup emails (verification + welcome) deliberately ignore the
  // member-email pause (Fund.confirmationEmailsPausedAt) — the member is
  // actively signing up and these emails are functional, not notifications.

  // Retry loop on paymentReference collisions. We INSERT and catch P2002
  // rather than SELECT-then-INSERT to avoid TOCTOU.
  for (let attempt = 0; attempt < MAX_REFERENCE_RETRIES; attempt++) {
    const paymentReference = generatePaymentReference();
    const verificationToken = requireVerify
      ? generateVerificationToken()
      : null;

    const initialEmail = requireVerify
      ? {
          type: "MEMBER_EMAIL_VERIFICATION" as const,
          subject: t("members.signup.emailTemplates.verify.subject" as never, {
            fundName: fund.name,
          } as never),
          idempotencyKey: `MEMBER_EMAIL_VERIFICATION:token:${verificationToken}`,
        }
      : {
          type: "MEMBER_WELCOME" as const,
          subject: t("members.signup.emailTemplates.welcome.subject" as never, {
            fundName: fund.name,
          } as never),
          // Filled with member id once we have it (the idempotency key
          // can't reference m.id before m exists).
          idempotencyKey: "",
        };

    let txResult:
      | {
          member: {
            id: string;
            email: string;
            firstName: string;
            paymentReference: string;
          };
          emailId: string;
        }
      | null = null;
    try {
      txResult = await prisma.$transaction(async (tx) => {
        const m = await tx.member.create({
          data: {
            fundId: fund.id,
            email: parsed.data.email,
            firstName: parsed.data.firstName,
            lastName: parsed.data.lastName,
            locale,
            status: "NEW",
            paymentReference,
            // Empty → null (use the tier target once a tier is assigned).
            // Gated on FIXED_PERIOD + tiers above.
            contributionAmount,
            emailVerifiedAt: requireVerify ? null : new Date(),
            // Typed columns the fund chose to collect on the form. Spread
            // before nothing else writes them, so an unconfigured column keeps
            // its schema default.
            ...builtinColumns,
            applicationData: applicationData ?? undefined,
          },
        });
        if (sponsor) {
          await tx.referral.create({
            data: {
              fundId: fund.id,
              sponsorId: sponsor.id,
              refereeId: m.id,
              codeUsed: sponsor.referralCode,
            },
          });
        }
        if (requireVerify) {
          await tx.emailVerification.create({
            data: {
              token: verificationToken!,
              memberId: m.id,
              email: m.email,
              expiresAt: verificationExpiry(),
            },
          });
        }
        const email = await tx.email.create({
          data: {
            fundId: fund.id,
            type: initialEmail.type,
            toEmail: m.email,
            memberId: m.id,
            idempotencyKey: requireVerify
              ? initialEmail.idempotencyKey
              : `MEMBER_WELCOME:member:${m.id}`,
            subject: initialEmail.subject,
          },
        });
        return {
          member: {
            id: m.id,
            email: m.email,
            firstName: m.firstName,
            paymentReference: m.paymentReference!,
          },
          emailId: email.id,
        };
      });
    } catch (e) {
      if (isUniqueViolationOn(e, "paymentReference")) continue;
      if (isUniqueViolationOn(e, "email")) {
        return {
          error: t("members.signup.errors.emailTaken" as never),
          field: "email",
        };
      }
      // Anything else is our problem, not the visitor's. Log it (Vercel
      // captures console.error) and hand back a terminal result so the fund's
      // error redirect can fire — a raw error boundary would strand a visitor
      // who arrived from the fund's own website with no way back.
      console.error("[signup] member creation failed", fund.id, e);
      return {
        error: t("members.signup.errors.generic" as never),
        redirectTo: errorRedirect(fund.memberSignupErrorUrl, "signup_failed"),
      };
    }

    // Outside the transaction: fire the Resend send. The sender catches
    // its own errors and updates the email row's status; signup never
    // fails because of an email problem.
    const fundBranding = {
      name: fund.name,
      primaryColor: fund.primaryColor,
      logoUrl: fund.logoUrl,
      senderEmail: fund.senderEmail,
    };
    if (requireVerify) {
      const verifyUrl = `${getFundUrl(fund.domain)}/verify-email?token=${encodeURIComponent(verificationToken!)}`;
      await sendMemberEmailVerification({
        emailId: txResult.emailId,
        toEmail: txResult.member.email,
        fund: fundBranding,
        firstName: txResult.member.firstName,
        verifyUrl,
      });
    } else {
      await sendMemberWelcome({
        emailId: txResult.emailId,
        fundId: fund.id,
        toEmail: txResult.member.email,
        fund: fundBranding,
        firstName: txResult.member.firstName,
      });
    }

    // If the form submit is the final step (no email verification), the
    // fund's configured success URL — when set — replaces the in-app
    // /thanks page. With verification on, the redirect happens after the
    // verify-email landing instead.
    const inAppThanks = `/join/thanks?id=${txResult.member.id}`;
    const redirectTo =
      !requireVerify && fund.memberSignupSuccessUrl
        ? fund.memberSignupSuccessUrl
        : inAppThanks;
    return { ok: true, redirectTo };
  }

  // Every attempt collided on paymentReference — vanishingly unlikely, and
  // nothing the visitor can act on, so it takes the error redirect too.
  return {
    error: t("members.signup.errors.generic" as never),
    redirectTo: errorRedirect(fund.memberSignupErrorUrl, "signup_failed"),
  };
}
