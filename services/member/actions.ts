"use server";

import { getTranslations } from "next-intl/server";
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
import { BuiltinSignupSchema, type BuiltinSignupInput } from "./schema";

export type SignupMemberResult =
  | { error: string; field?: "firstName" | "lastName" | "email" }
  | { ok: true; redirectTo: string };

const MAX_REFERENCE_RETRIES = 5;

export async function signupMemberAction(input: {
  builtins: BuiltinSignupInput;
  applicationData?: Record<string, string>;
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

  // Filter application data to keys that exist on the fund's onboarding form,
  // and enforce the `required` flag for each. Anything unknown is dropped
  // (defensive against client tampering).
  const fields = await prisma.onboardingField.findMany({
    where: { fundId: fund.id, target: "MEMBER", archivedAt: null },
    select: { key: true, label: true, required: true },
  });
  const incoming = input.applicationData ?? {};
  const filtered: Record<string, string> = {};
  for (const field of fields) {
    const value = incoming[field.key];
    if (field.required && (!value || value.trim() === "")) {
      return {
        error: t("members.signup.errors.fieldRequired" as never, {
          label: field.label,
        } as never),
      };
    }
    if (value !== undefined && value !== "") filtered[field.key] = value;
  }

  // Resolve the referral code if any. Soft-fail on invalid / self-referral —
  // the code came from a hidden URL param the visitor never saw, so showing
  // an error would be confusing.
  let sponsor: { id: string; referralCode: string } | null = null;
  if (input.referralCode) {
    const found = await prisma.member.findFirst({
      where: { fundId: fund.id, referralCode: input.referralCode },
      select: { id: true, referralCode: true, email: true, status: true },
    });
    if (
      found &&
      found.referralCode &&
      found.email !== parsed.data.email &&
      found.status !== "LEFT"
    ) {
      sponsor = { id: found.id, referralCode: found.referralCode };
    }
  }

  const requireVerify = fund.requireMemberEmailVerification;

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
          subject: t("members.signup.email.verify.subject" as never, {
            fundName: fund.name,
          } as never),
          idempotencyKey: `MEMBER_EMAIL_VERIFICATION:token:${verificationToken}`,
        }
      : {
          type: "MEMBER_WELCOME" as const,
          subject: t("members.signup.email.welcome.subject" as never, {
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
            status: "ONBOARDING",
            paymentReference,
            emailVerifiedAt: requireVerify ? null : new Date(),
            applicationData:
              Object.keys(filtered).length > 0 ? filtered : undefined,
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
      if (isP2002For(e, "paymentReference")) continue;
      if (isP2002For(e, "email")) {
        return {
          error: t("members.signup.errors.emailTaken" as never),
          field: "email",
        };
      }
      throw e;
    }

    // Outside the transaction: fire the Resend send. The sender catches
    // its own errors and updates the email row's status; signup never
    // fails because of an email problem.
    if (requireVerify) {
      const verifyUrl = `${getFundUrl(fund.domain)}/verify-email?token=${encodeURIComponent(verificationToken!)}`;
      await sendMemberEmailVerification({
        emailId: txResult.emailId,
        toEmail: txResult.member.email,
        fundName: fund.name,
        firstName: txResult.member.firstName,
        verifyUrl,
      });
    } else {
      await sendMemberWelcome({
        emailId: txResult.emailId,
        toEmail: txResult.member.email,
        fundName: fund.name,
        firstName: txResult.member.firstName,
        paymentReference: txResult.member.paymentReference,
      });
    }

    return { ok: true, redirectTo: `/join/thanks?id=${txResult.member.id}` };
  }

  return { error: t("members.signup.errors.generic" as never) };
}

function isP2002For(e: unknown, field: string): boolean {
  if (!(e instanceof Error) || !("code" in e)) return false;
  if ((e as { code?: string }).code !== "P2002") return false;
  const meta = (e as { meta?: { target?: unknown } }).meta;
  if (!meta?.target) return false;
  const target = Array.isArray(meta.target) ? meta.target : [meta.target];
  return target.some((t) => typeof t === "string" && t.includes(field));
}
