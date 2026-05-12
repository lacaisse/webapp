"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireFundRole } from "@/services/auth/dal";
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

// --- Token ---------------------------------------------------------------

const TokenSchema = z.object({
  tokenName: z.string().or(z.literal("")).nullable().optional(),
  tokenSymbol: z.string().or(z.literal("")).nullable().optional(),
});

export async function updateTokenSettingsAction(
  input: z.infer<typeof TokenSchema>,
): Promise<SettingsResult> {
  return runUpdate(TokenSchema, normaliseBlanks(input), "/settings");
}

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

// --- Citizen Pay ---------------------------------------------------------

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

