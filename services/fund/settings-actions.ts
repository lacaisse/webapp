// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireFundRole } from "@/services/auth/dal";
import { getCitizenPayClient } from "@/services/citizenpay/client";
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

// --- General -------------------------------------------------------------

const GeneralSchema = z.object({
  name: z.string().min(2, { error: "settings.errors.nameMin" }),
  defaultLocale: z
    .string()
    .refine((v) => isSupportedLocale(v), {
      error: "settings.errors.localeUnsupported",
    }),
  timezone: z.string().min(1, { error: "settings.errors.timezoneRequired" }),
  allocationMode: z.enum(["FIXED_PERIOD", "PAY_AND_GO"]),
  // Day-of-month for FIXED_PERIOD cutoffs. 31 = last day of every month.
  allocationCutoffDay: z.coerce
    .number({ error: "settings.errors.cutoffDayInvalid" })
    .int({ error: "settings.errors.cutoffDayInvalid" })
    .min(1, { error: "settings.errors.cutoffDayInvalid" })
    .max(31, { error: "settings.errors.cutoffDayInvalid" }),
});

export async function updateGeneralSettingsAction(
  input: z.infer<typeof GeneralSchema>,
): Promise<SettingsResult> {
  return runUpdate(GeneralSchema, input, "/settings");
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
// Per-fund platform fee on merchant payments. We are canonical: persist the
// value locally first (the DB may lead CP), then push it to CitizenPay as
// integer basis points. A failed push leaves `payoutFeeSynced = false` and
// returns a warning so the admin can retry by saving again. Clearing the
// field stores null and skips the push — the assumed CP endpoint takes a
// concrete bps value, not a "reset to default" signal.

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

  // DB-first: the local value is authoritative even if the CP push fails.
  // Mark unsynced up front; flip to synced only once CP accepts it.
  await prisma.fund.update({
    where: { id: fund.id },
    data: { payoutFeePercentage: value, payoutFeeSynced: value === null },
  });

  // Nothing to push when cleared.
  if (value === null) {
    revalidatePath("/settings");
    return { ok: true };
  }

  try {
    const client = getCitizenPayClient(fund);
    await client.setPayoutFeePercentage(value);
    await prisma.fund.update({
      where: { id: fund.id },
      data: { payoutFeeSynced: true },
    });
  } catch (e) {
    console.error("[settings] payout fee CP sync failed", fund.id, e);
    revalidatePath("/settings");
    return { ok: true, warning: t("fund.settings.fees.syncFailed") };
  }

  revalidatePath("/settings");
  return { ok: true };
}

// --- Helpers -------------------------------------------------------------

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

