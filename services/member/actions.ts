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
import { isFieldVisible, parseVisibleIf } from "@/services/onboarding/visibility";
import {
  coerceBuiltinValue,
  isMemberBuiltinKey,
  type BuiltinColumnValue,
} from "./builtin-fields";
import { contributionApplies, isBelowTierMinimum } from "./contribution";
import { generatePaymentReference } from "./payment-reference";
import {
  BuiltinSignupSchema,
  type BuiltinSignupInput,
  type ExtraValue,
} from "./schema";

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

  // Commitment amount only applies to FIXED_PERIOD funds with tiers — ignore a
  // submitted value otherwise (the field isn't shown, but don't trust that).
  // The id set doubles as the allowlist for a submitted tierId builtin answer
  // below — a live, non-archived tier of THIS fund, same rule as the admin
  // tier picker (services/member/admin-tier-actions.ts).
  const liveTiers = await prisma.allocationTier.findMany({
    where: { fundId: fund.id, archivedAt: null },
    select: { id: true, hiddenAtSignup: true, minContribution: true },
  });
  // The allowlist is the signup-VISIBLE subset (issue #37) — a tier hidden from
  // the picker must also be rejected when named directly, or hiding it would be
  // cosmetic. The contribution check below still counts every live tier: hiding
  // a tier from applicants doesn't change whether the fund runs on tiers.
  const liveTierIds = new Set(
    liveTiers.filter((t) => !t.hiddenAtSignup).map((t) => t.id),
  );
  const contributionAmount = contributionApplies(fund.allocationMode, liveTiers.length)
    ? parsed.data.contributionAmount || null
    : null;

  // Filter answers to keys that exist on the fund's onboarding form, and
  // enforce the `required` flag for each. Anything unknown is dropped
  // (defensive against client tampering).
  //
  // Fields carrying a `builtinKey` are split off here: their answers belong in
  // typed Member columns, not in the applicationData blob, so that an address
  // collected at signup is the same address the email templates and tier
  // assignment read. See services/member/builtin-fields.ts.
  const fields = await prisma.onboardingField.findMany({
    where: { fundId: fund.id, target: "MEMBER", archivedAt: null },
    select: {
      key: true,
      label: true,
      required: true,
      builtinKey: true,
      visibleIf: true,
    },
  });
  const incoming = input.applicationData ?? {};
  const filtered: Record<string, ExtraValue> = {};
  const builtinColumns: Record<string, BuiltinColumnValue> = {};
  for (const field of fields) {
    const value = incoming[field.key];
    // A field hidden by its own visibleIf rule (dependency unanswered / not
    // yet satisfying the comparison) is neither required nor stored — a
    // stale answer left over from before the visitor's dependency answer
    // changed shouldn't persist. `visibleIf.fieldKey` only ever references
    // another custom field (enforced at save time), so `incoming` alone —
    // not the typed builtins — is the right lookup source.
    if (!isFieldVisible(parseVisibleIf(field.visibleIf), incoming)) continue;
    if (field.required && isExtraEmpty(value)) {
      return {
        error: t("members.signup.errors.fieldRequired" as never, {
          label: field.label,
        } as never),
      };
    }
    if (isExtraEmpty(value)) continue;

    if (field.builtinKey && isMemberBuiltinKey(field.builtinKey)) {
      const coerced = coerceBuiltinValue(field.builtinKey, value);
      if (!coerced.ok) {
        return {
          error: t("members.signup.errors.fieldInvalid" as never, {
            label: field.label,
          } as never),
        };
      }
      // A null here means "answered blank"; leave the column at its default
      // rather than writing null over a non-nullable count.
      if (coerced.value !== null) {
        // coerceBuiltinValue only checks the answer's shape (builtin-fields.ts
        // has no Prisma access) — for tierId specifically, confirm it names a
        // tier this fund actually has live today, so a tampered id can't
        // link a member to another fund's tier (or an archived one).
        if (field.builtinKey === "tierId" && !liveTierIds.has(coerced.value)) {
          return {
            error: t("members.signup.errors.fieldInvalid" as never, {
              label: field.label,
            } as never),
          };
        }
        builtinColumns[field.builtinKey] = coerced.value;
      }
      continue;
    }

    filtered[field.key] = normalizeExtra(value!);
  }

  // A committed amount below the chosen tier's floor blocks the signup
  // (issue #158) — same rule the admin/member edit paths already enforce.
  // Only checkable when the fund's form collects a tier (builtin tierId,
  // #157); with no tier chosen there is no floor, and an empty amount
  // defaults to the tier target which is ≥ the floor by definition.
  const chosenTier =
    typeof builtinColumns.tierId === "string"
      ? liveTiers.find((tier) => tier.id === builtinColumns.tierId)
      : undefined;
  if (
    contributionAmount !== null &&
    chosenTier &&
    isBelowTierMinimum(
      Number(contributionAmount),
      Number(chosenTier.minContribution),
    )
  ) {
    return {
      error: t("members.signup.errors.amountBelowTierMin" as never, {
        min: chosenTier.minContribution.toString(),
      } as never),
      field: "contributionAmount",
    };
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
      found.status !== "STOPPED"
    ) {
      sponsor = { id: found.id, referralCode: found.referralCode };
    }
  }

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
            emailUnsubscribed: parsed.data.remindersOptOut ?? false,
            emailUnsubscribedAt: parsed.data.remindersOptOut
              ? new Date()
              : null,
            // Empty → null (use the tier target once a tier is assigned).
            // Gated on FIXED_PERIOD + tiers above.
            contributionAmount,
            emailVerifiedAt: requireVerify ? null : new Date(),
            // Typed columns the fund chose to collect on the form. Spread
            // before nothing else writes them, so an unconfigured column keeps
            // its schema default.
            ...builtinColumns,
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
