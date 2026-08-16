// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireFundRole } from "@/services/auth/dal";
import {
  getCitizenPayClient,
  type FundCredentials,
} from "@/services/citizenpay/client";
import type { PayoutFeeConfig } from "@/services/citizenpay/types";
import { prisma } from "@/services/db/prisma";
import { isSupportedLocale } from "@/services/i18n/config";

export type SettingsResult = { ok: true } | { error: string };

// --- Onboarding toggles --------------------------------------------------

export type UpdateOnboardingSettingsInput = {
  requireMemberEmailVerification?: boolean;
  requireMerchantEmailVerification?: boolean;
};

export async function updateOnboardingSettingsAction(
  input: UpdateOnboardingSettingsInput,
): Promise<SettingsResult> {
  const { fund } = await requireFundRole("ADMIN");

  const data: UpdateOnboardingSettingsInput = {};
  if (typeof input.requireMemberEmailVerification === "boolean") {
    data.requireMemberEmailVerification = input.requireMemberEmailVerification;
  }
  if (typeof input.requireMerchantEmailVerification === "boolean") {
    data.requireMerchantEmailVerification =
      input.requireMerchantEmailVerification;
  }

  if (Object.keys(data).length === 0) return { ok: true };

  await prisma.fund.update({ where: { id: fund.id }, data });
  revalidatePath("/settings");
  return { ok: true };
}

// --- Email pause ----------------------------------------------------------

// Pause/resume the member-facing NOTIFICATION emails: payment confirmation
// (bank-sync ingest), allocation confirmation + referral bonus
// (operation-status cron), member activated and member invited (admin
// actions). While paused those sends are skipped, not queued — resuming
// never emails retroactively. Signup-flow emails (verification, welcome)
// stay functional regardless — the member is actively signing up and needs
// them — and password emails are auth-level (Better Auth's sendResetPassword
// callback → services/email/resend.ts), outside this flag entirely. Merchant
// and team emails are unaffected.
export async function setConfirmationEmailsPausedAction(input: {
  paused: boolean;
}): Promise<SettingsResult> {
  const { fund } = await requireFundRole("ADMIN");

  await prisma.fund.update({
    where: { id: fund.id },
    data: {
      confirmationEmailsPausedAt: input.paused
        ? (fund.confirmationEmailsPausedAt ?? new Date())
        : null,
    },
  });

  revalidatePath("/settings");
  return { ok: true };
}

// --- Member sender address -----------------------------------------------
// Custom From for member-facing transactional emails. Stored as a bare
// address; the display name is the fund name at send time. Blank clears it
// (falls back to the platform EMAIL_FROM). Merchant/team and Better Auth
// (e.g. password reset) emails are unaffected.

const MemberSenderSchema = z.object({
  senderEmail: z
    .string()
    .email({ error: "settings.errors.emailInvalid" })
    .or(z.literal(""))
    .nullable()
    .optional(),
});

export async function updateMemberSenderEmailAction(
  input: z.infer<typeof MemberSenderSchema>,
): Promise<SettingsResult> {
  return runUpdate(MemberSenderSchema, normaliseBlanks(input), "/settings");
}

// --- General -------------------------------------------------------------

const GeneralSchema = z.object({
  name: z.string().min(2, { error: "settings.errors.nameMin" }),
  // Optional full / legal name. Blank is stored as null (falls back to `name`).
  // Transformed here rather than via normaliseBlanks so the required `name`
  // field keeps its own validation message.
  fullName: z
    .string()
    .max(200, { error: "settings.errors.nameTooLong" })
    .nullish()
    .transform((v) => (v && v.trim() ? v.trim() : null)),
  defaultLocale: z
    .string()
    .refine((v) => isSupportedLocale(v), {
      error: "settings.errors.localeUnsupported",
    }),
  timezone: z.string().min(1, { error: "settings.errors.timezoneRequired" }),
  allocationMode: z.enum(["FIXED_PERIOD", "PAY_AND_GO", "DISABLED"]),
  // Day-of-month for FIXED_PERIOD cutoffs. 31 = last day of every month.
  allocationCutoffDay: z.coerce
    .number({ error: "settings.errors.cutoffDayInvalid" })
    .int({ error: "settings.errors.cutoffDayInvalid" })
    .min(1, { error: "settings.errors.cutoffDayInvalid" })
    .max(31, { error: "settings.errors.cutoffDayInvalid" }),
});

export async function updateGeneralSettingsAction(
  input: z.infer<typeof GeneralSchema>,
): Promise<FeeSettingsResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");
  const parsed = GeneralSchema.safeParse(input);
  if (!parsed.success) {
    return { error: t(parsed.error.issues[0].message as never) };
  }

  await prisma.fund.update({ where: { id: fund.id }, data: parsed.data });

  // The timezone isn't only ours: CP evaluates the MONTHLY fee boundary in
  // it, so a month "ends" at a different instant per fund. Re-push the fee
  // config here or the new zone wouldn't reach CP until someone happens to
  // save the Fees tab. Only worth a call once the fund has credentials and a
  // rate — without those there's no fee config on CP's side to correct.
  const timezoneChanged = parsed.data.timezone !== fund.timezone;
  const currentFee = fund.payoutFeePercentage;
  if (timezoneChanged && currentFee != null && fund.citizenPayApiKeyId != null) {
    const landed = await pushFeeConfigToCitizenPay(fund, {
      percent: currentFee.toString(),
      collectionFrequency: fund.feeCollectionFrequency,
      timezone: parsed.data.timezone,
    });
    if (!landed) {
      revalidatePath("/settings");
      return { ok: true, warning: t("fund.settings.fees.timezoneSyncFailed") };
    }
  }

  revalidatePath("/settings");
  return { ok: true };
}

// --- Branding ------------------------------------------------------------

const BrandingSchema = z.object({
  logoUrl: z.string().url().or(z.literal("")).nullable().optional(),
  primaryColor: z
    .string()
    .regex(/^#?[0-9a-fA-F]{6}$/, { error: "settings.errors.colorInvalid" })
    .or(z.literal(""))
    .nullable()
    .optional(),
  websiteUrl: z
    .string()
    .url({ error: "settings.errors.urlInvalid" })
    .or(z.literal(""))
    .nullable()
    .optional(),
});

export async function updateBrandingSettingsAction(
  input: z.infer<typeof BrandingSchema>,
): Promise<SettingsResult> {
  return runUpdate(BrandingSchema, normaliseBlanks(input), "/settings");
}

// Token settings are NOT editable here — token info comes from the
// connected CitizenPay treasury (see services/citizenpay/sync.ts) and
// fills `Fund.token*` columns. The settings UI surfaces them read-only.

// --- Legal ---------------------------------------------------------------

const LegalSchema = z.object({
  termsUrl: z.string().url().or(z.literal("")).nullable().optional(),
  privacyUrl: z.string().url().or(z.literal("")).nullable().optional(),
});

export async function updateLegalSettingsAction(
  input: z.infer<typeof LegalSchema>,
): Promise<SettingsResult> {
  return runUpdate(LegalSchema, normaliseBlanks(input), "/settings");
}

// --- Signup redirects ----------------------------------------------------

// Where a signup flow hands the visitor back to the fund's own website. These
// are admin config on purpose: the public /join form never takes a redirect
// target from the query string, which would make it an open redirect anyone
// could point at a phishing page.
const SignupRedirectsSchema = z.object({
  memberSignupSuccessUrl: z
    .string()
    .url({ error: "settings.errors.urlInvalid" })
    .or(z.literal(""))
    .nullable()
    .optional(),
  merchantSignupSuccessUrl: z
    .string()
    .url({ error: "settings.errors.urlInvalid" })
    .or(z.literal(""))
    .nullable()
    .optional(),
  memberSignupCancelUrl: z
    .string()
    .url({ error: "settings.errors.urlInvalid" })
    .or(z.literal(""))
    .nullable()
    .optional(),
  memberSignupErrorUrl: z
    .string()
    .url({ error: "settings.errors.urlInvalid" })
    .or(z.literal(""))
    .nullable()
    .optional(),
});

export async function updateSignupRedirectsAction(
  input: z.infer<typeof SignupRedirectsSchema>,
): Promise<SettingsResult> {
  return runUpdate(SignupRedirectsSchema, normaliseBlanks(input), "/settings");
}

// --- Citizen Pay ---------------------------------------------------------
// Manual treasury_id entry. The matching API key is minted via the redirect
// flow in /api/citizenpay/connect — see services/citizenpay/connect.ts.

const CitizenPaySchema = z.object({
  citizenPayFundId: z.string().or(z.literal("")).nullable().optional(),
});

export async function updateCitizenPaySettingsAction(
  input: z.infer<typeof CitizenPaySchema>,
): Promise<SettingsResult> {
  return runUpdate(CitizenPaySchema, normaliseBlanks(input), "/settings");
}

// --- Referrals -----------------------------------------------------------

const ReferralSchema = z.object({
  referralBonusAmount: z
    .string()
    .regex(/^\d+(\.\d{1,2})?$/, { error: "settings.errors.amountInvalid" })
    .or(z.literal(""))
    .nullable()
    .optional(),
});

export async function updateReferralSettingsAction(
  input: z.infer<typeof ReferralSchema>,
): Promise<SettingsResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");
  const parsed = ReferralSchema.safeParse(input);
  if (!parsed.success) {
    return { error: t(parsed.error.issues[0].message as never) };
  }
  const raw = parsed.data.referralBonusAmount;
  await prisma.fund.update({
    where: { id: fund.id },
    data: {
      referralBonusAmount: raw && raw !== "" ? raw : null,
    },
  });
  revalidatePath("/settings");
  revalidatePath("/referrals");
  return { ok: true };
}

// --- Payout fee ----------------------------------------------------------
// Per-fund platform fee on merchant payments: the rate, and the cadence at
// which CitizenPay collects it (per payment, or once at month end — the
// collection itself runs CP-side, we only mirror the choice). We are
// canonical for both: persist locally first (the DB may lead CP), then push
// rate + cadence — plus the fund's timezone, which is what makes "month end"
// a definite instant — together in one call. A failed push leaves
// `payoutFeeSynced = false` and returns a warning so the admin can retry by
// saving again. Clearing the rate stores null (keeping the cadence locally)
// and skips the push — the assumed CP endpoint takes a concrete bps value,
// not a "reset to default" signal.

export type FeeSettingsResult =
  | { ok: true; warning?: string }
  | { error: string };

const PayoutFeeSchema = z.object({
  payoutFeePercentage: z
    .string()
    .regex(/^\d+(\.\d{1,2})?$/, { error: "settings.errors.feeInvalid" })
    .refine((v) => Number(v) <= 100, { error: "settings.errors.feeTooHigh" })
    .or(z.literal(""))
    .nullable()
    .optional(),
  // Optional: callers that don't send it keep whatever the fund already has
  // (so an older client can't silently reset a fund to per-payment).
  feeCollectionFrequency: z.enum(["PER_PAYMENT", "MONTHLY"]).optional(),
});

export async function updatePayoutFeeAction(
  input: z.infer<typeof PayoutFeeSchema>,
): Promise<FeeSettingsResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");
  const parsed = PayoutFeeSchema.safeParse(input);
  if (!parsed.success) {
    return { error: t(parsed.error.issues[0].message as never) };
  }

  const raw = parsed.data.payoutFeePercentage;
  const value = raw && raw !== "" ? raw : null;
  const frequency = parsed.data.feeCollectionFrequency ?? fund.feeCollectionFrequency;

  // DB-first: the local values are authoritative even if the CP push fails.
  // Mark unsynced up front; flip to synced only once CP accepts them.
  await prisma.fund.update({
    where: { id: fund.id },
    data: {
      payoutFeePercentage: value,
      feeCollectionFrequency: frequency,
      payoutFeeSynced: value === null,
    },
  });

  // Nothing to push when the rate is cleared — the cadence alone isn't a
  // valid fee config for the assumed CP endpoint. It stays stored locally
  // and rides along with the next push that sets a rate.
  if (value === null) {
    revalidatePath("/settings");
    return { ok: true };
  }

  const landed = await pushFeeConfigToCitizenPay(fund, {
    percent: value,
    collectionFrequency: frequency,
    // CP evaluates the month-end boundary in the fund's own zone.
    timezone: fund.timezone,
  });

  revalidatePath("/settings");
  return landed
    ? { ok: true }
    : { ok: true, warning: t("fund.settings.fees.syncFailed") };
}

// --- Helpers -------------------------------------------------------------

// Push a fund's fee config (rate + cadence + timezone) to CitizenPay and
// record whether it landed in `payoutFeeSynced`. Best-effort by contract: the
// local row is canonical, so a failure is not an error for the caller — it
// returns false and the caller surfaces a retry hint in its own words.
async function pushFeeConfigToCitizenPay(
  fund: FundCredentials,
  config: PayoutFeeConfig,
): Promise<boolean> {
  try {
    await getCitizenPayClient(fund).setPayoutFeeConfig(config);
    await prisma.fund.update({
      where: { id: fund.id },
      data: { payoutFeeSynced: true },
    });
    return true;
  } catch (e) {
    console.error("[settings] fee config CP sync failed", fund.id, e);
    await prisma.fund.update({
      where: { id: fund.id },
      data: { payoutFeeSynced: false },
    });
    return false;
  }
}

async function runUpdate<T extends z.ZodType>(
  schema: T,
  input: unknown,
  pathToRevalidate: string,
): Promise<SettingsResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return { error: t(parsed.error.issues[0].message as never) };
  }
  await prisma.fund.update({ where: { id: fund.id }, data: parsed.data });
  revalidatePath(pathToRevalidate);
  return { ok: true };
}

// Convert empty strings to nulls so optional URL/text fields can be cleared.
function normaliseBlanks<T extends Record<string, unknown>>(input: T): T {
  const result = { ...input };
  for (const key of Object.keys(result)) {
    const k = key as keyof T;
    if (result[k] === "") {
      (result as Record<string, unknown>)[key] = null;
    }
  }
  return result;
}

