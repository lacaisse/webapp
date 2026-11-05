// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";

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
