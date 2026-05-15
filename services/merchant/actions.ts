// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";

import { prisma } from "@/services/db/prisma";
import {
  sendMerchantEmailVerification,
  sendMerchantWelcome,
} from "@/services/email/transactional";
import {
  generateVerificationToken,
  verificationExpiry,
} from "@/services/email/verification";
import { getFundUrl, requireCurrentFund } from "@/services/fund/server";
import {
  BuiltinMerchantSignupSchema,
  type BuiltinMerchantSignupInput,
  type ExtraValue,
} from "./schema";

export type SignupMerchantField =
  | "name"
  | "description"
  | "contactName"
  | "email"
  | "phone"
  | "website"
  | "logoUrl"
  | "address"
  | "postalCode"
  | "city"
  | "country";

export type SignupMerchantResult =
  | { error: string; field?: SignupMerchantField }
  | { ok: true; redirectTo: string };

export async function signupMerchantAction(input: {
  builtins: BuiltinMerchantSignupInput;
  applicationData?: Record<string, ExtraValue>;
}): Promise<SignupMerchantResult> {
  const t = await getTranslations();

  const parsed = BuiltinMerchantSignupSchema.safeParse(input.builtins);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      error: t(issue.message as never),
      field: issue.path[0] as SignupMerchantField | undefined,
    };
  }

  const fund = await requireCurrentFund();

  // Filter application data to known OnboardingField keys, enforce `required`.
  const fields = await prisma.onboardingField.findMany({
    where: { fundId: fund.id, target: "MERCHANT", archivedAt: null },
    select: { key: true, label: true, required: true },
  });
  const incoming = input.applicationData ?? {};
  const filtered: Record<string, ExtraValue> = {};
  for (const field of fields) {
    const value = incoming[field.key];
    if (field.required && isExtraEmpty(value)) {
      return {
        error: t("merchants.signup.errors.fieldRequired" as never, {
          label: field.label,
        } as never),
      };
    }
    if (!isExtraEmpty(value)) {
      filtered[field.key] = normalizeExtra(value!);
    }
  }

  const requireVerify = fund.requireMerchantEmailVerification;
  const verificationToken = requireVerify ? generateVerificationToken() : null;

  // Pick the right email type + idempotency key + subject based on whether
  // verification is on for this fund. If off, the merchant lands in the
  // admin review queue immediately with their email marked verified.
  const initialEmail = requireVerify
    ? {
        type: "MERCHANT_EMAIL_VERIFICATION" as const,
        subject: t("merchants.signup.email.verify.subject" as never, {
          fundName: fund.name,
        } as never),
        idempotencyKey: `MERCHANT_EMAIL_VERIFICATION:token:${verificationToken}`,
      }
    : {
        type: "MERCHANT_WELCOME" as const,
        subject: t("merchants.signup.email.welcome.subject" as never, {
          fundName: fund.name,
        } as never),
        idempotencyKey: "", // filled below once we know the merchant id
      };

  let txResult:
    | {
        merchant: { id: string; email: string; name: string };
        emailId: string;
      }
    | null = null;
  try {
    txResult = await prisma.$transaction(async (tx) => {
      const m = await tx.merchant.create({
        data: {
          fundId: fund.id,
          name: parsed.data.name,
          description: parsed.data.description || null,
          contactName: parsed.data.contactName,
          email: parsed.data.email,
          phone: parsed.data.phone || null,
          website: parsed.data.website || null,
          logoUrl: parsed.data.logoUrl || null,
          address: parsed.data.address,
          postalCode: parsed.data.postalCode,
          city: parsed.data.city,
          country: parsed.data.country,
          status: "PENDING",
          emailVerifiedAt: requireVerify ? null : new Date(),
          applicationData:
            Object.keys(filtered).length > 0 ? filtered : undefined,
        },
      });
      if (requireVerify) {
        await tx.emailVerification.create({
          data: {
            token: verificationToken!,
            merchantId: m.id,
            email: m.email!,
            expiresAt: verificationExpiry(),
          },
        });
      }
      const email = await tx.email.create({
        data: {
          fundId: fund.id,
          type: initialEmail.type,
          toEmail: m.email!,
          merchantId: m.id,
          idempotencyKey: requireVerify
            ? initialEmail.idempotencyKey
            : `MERCHANT_WELCOME:merchant:${m.id}`,
          subject: initialEmail.subject,
        },
      });
      return {
        merchant: { id: m.id, email: m.email!, name: m.name },
        emailId: email.id,
      };
    });
  } catch (e) {
    if (isP2002For(e, "name")) {
      return {
        error: t("merchants.signup.errors.nameTaken" as never),
        field: "name",
      };
    }
    throw e;
  }

  // Outside transaction: dispatch the Resend send. Failures don't block —
  // the merchant can request a resend later.
  if (requireVerify) {
    const verifyUrl = `${getFundUrl(fund.domain)}/verify-email?token=${encodeURIComponent(verificationToken!)}`;
    await sendMerchantEmailVerification({
      emailId: txResult.emailId,
      toEmail: txResult.merchant.email,
      fundName: fund.name,
      merchantName: txResult.merchant.name,
      verifyUrl,
    });
  } else {
    await sendMerchantWelcome({
      emailId: txResult.emailId,
      toEmail: txResult.merchant.email,
      fundName: fund.name,
      merchantName: txResult.merchant.name,
    });
  }

  return {
    ok: true,
    redirectTo: `/join-merchant/thanks?id=${txResult.merchant.id}`,
  };
}

function isExtraEmpty(value: ExtraValue | undefined): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "boolean") return value === false;
  return false;
}

function normalizeExtra(value: ExtraValue): ExtraValue {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map((v) => v.trim()).filter(Boolean);
  return value;
}

function isP2002For(e: unknown, field: string): boolean {
  if (!(e instanceof Error) || !("code" in e)) return false;
  if ((e as { code?: string }).code !== "P2002") return false;
  const meta = (e as { meta?: { target?: unknown } }).meta;
  if (!meta?.target) return false;
  const target = Array.isArray(meta.target) ? meta.target : [meta.target];
  return target.some((t) => typeof t === "string" && t.includes(field));
}
