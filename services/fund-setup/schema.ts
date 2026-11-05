// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";

import { PASSWORD_MIN_LENGTH } from "@/app/(auth-host)/schemas";
import { CreateFundSchema } from "@/services/fund/schema";

import { isWellFormedWaiverCode, normaliseWaiverCode } from "./waiver-codes";

export { PASSWORD_MIN_LENGTH };

// Settings → Subscription: an OWNER accepts the La Caisse hosting plan and
// gives the details Citizen Pay's billing invoices against. Shared by the form
// (client validation) and the server action (re-validation).
//
// Error messages are translation KEYS — clients call t() at display time,
// the action calls getTranslations() server-side.

export const BILLING_LEGAL_NAME_MIN = 2;
export const BILLING_LEGAL_NAME_MAX = 200;
export const BILLING_ADDRESS_MIN = 5;
export const BILLING_ADDRESS_MAX = 500;

// People paste VAT numbers as printed ("BE 0123.456.789", "be0123-456-789");
// store one spelling so the invoice and any later lookup agree.
export function normaliseVatNumber(raw: string): string {
  return raw.toUpperCase().replace(/[\s.-]/g, "");
}

// Two-letter country prefix + 2–12 alphanumerics: loose enough for every EU
// format, strict enough to catch a pasted IBAN fragment or a stray word.
const VAT_NUMBER = /^$|^[A-Z]{2}[A-Z0-9]{2,12}$/;

export const AcceptSubscriptionSchema = z.object({
  legalName: z
    .string()
    .trim()
    .min(BILLING_LEGAL_NAME_MIN, { error: "fund.settings.subscription.errors.legalNameMin" })
    .max(BILLING_LEGAL_NAME_MAX, { error: "fund.settings.subscription.errors.legalNameMax" }),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email({ error: "fund.settings.subscription.errors.emailInvalid" }),
  address: z
    .string()
    .trim()
    .min(BILLING_ADDRESS_MIN, { error: "fund.settings.subscription.errors.addressMin" })
    .max(BILLING_ADDRESS_MAX, { error: "fund.settings.subscription.errors.addressMax" }),
  // Optional: "" (after normalisation) = the fund has no VAT number; the
  // action stores that as null.
  vatNumber: z
    .string()
    .transform(normaliseVatNumber)
    .pipe(z.string().regex(VAT_NUMBER, { error: "fund.settings.subscription.errors.vatInvalid" })),
  accepted: z.literal(true, { error: "fund.settings.subscription.errors.mustAccept" }),
});
export type AcceptSubscriptionInput = z.input<typeof AcceptSubscriptionSchema>;
export type AcceptSubscriptionValues = z.output<typeof AcceptSubscriptionSchema>;

// A waiver code as a person types it: normalised first (case, dashes and
// look-alike letters don't matter), then checked for shape only — whether it
// exists is the action's business. The error keys differ per door: Settings →
// Subscription names the code's state, the public /join page never does.
function waiverCodeField(requiredKey: string, invalidKey: string) {
  return z
    .string()
    .transform(normaliseWaiverCode)
    .pipe(
      z
        .string()
        .min(1, { error: requiredKey })
        .refine(isWellFormedWaiverCode, { error: invalidKey }),
    );
}

// Settings → Subscription, "Have an invite code?": an OWNER redeems a waiver
// code for a fund that already exists.
export const RedeemWaiverCodeSchema = z.object({
  code: waiverCodeField(
    "fund.settings.subscription.errors.codeRequired",
    "fund.settings.subscription.errors.codeInvalid",
  ),
});
export type RedeemWaiverCodeInput = z.input<typeof RedeemWaiverCodeSchema>;

// The apex /join door (join-actions.ts): a waiver code, an account and a fund
// in one submit. The code field is the redeem field with the public page's
// messages; the account fields are the auth host's sign-up rules (email
// stored lowercase, like every account); the fund fields are /new's.
export const JoinWithCodeSchema = CreateFundSchema.extend({
  code: waiverCodeField("join.errors.codeRequired", "join.errors.codeInvalid"),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email({ error: "auth.errors.emailInvalid" })),
  password: z.string().min(PASSWORD_MIN_LENGTH, { error: "auth.errors.passwordMin" }),
});
export type JoinWithCodeInput = z.input<typeof JoinWithCodeSchema>;
export type JoinWithCodeValues = z.output<typeof JoinWithCodeSchema>;

// Apex /admin/waivers: a platform admin mints a code. The label is who or why
// ("contributor: Alice", "école communale de X") and becomes the fund's
// waiver reason, so it is written for the fund to read. Numbers arrive as
// numbers: the form converts before calling the action.
export const WAIVER_LABEL_MIN = 2;
export const WAIVER_LABEL_MAX = 120;
export const WAIVER_MAX_USES_MAX = 1000;
export const WAIVER_EXPIRES_DAYS_MAX = 365;

export const CreateWaiverCodeSchema = z.object({
  label: z
    .string()
    .trim()
    .min(WAIVER_LABEL_MIN, { error: "admin.waivers.errors.labelMin" })
    .max(WAIVER_LABEL_MAX, { error: "admin.waivers.errors.labelMax" }),
  maxUses: z
    .number({ error: "admin.waivers.errors.maxUsesRange" })
    .int({ error: "admin.waivers.errors.maxUsesRange" })
    .min(1, { error: "admin.waivers.errors.maxUsesRange" })
    .max(WAIVER_MAX_USES_MAX, { error: "admin.waivers.errors.maxUsesRange" }),
  // null = the code never expires.
  expiresInDays: z
    .number({ error: "admin.waivers.errors.expiresRange" })
    .int({ error: "admin.waivers.errors.expiresRange" })
    .min(1, { error: "admin.waivers.errors.expiresRange" })
    .max(WAIVER_EXPIRES_DAYS_MAX, { error: "admin.waivers.errors.expiresRange" })
    .nullable(),
});
export type CreateWaiverCodeInput = z.input<typeof CreateWaiverCodeSchema>;
export type CreateWaiverCodeValues = z.output<typeof CreateWaiverCodeSchema>;
