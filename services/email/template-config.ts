// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";

import { SUPPORTED_LOCALES } from "@/services/i18n/config";

// Registry of the emails whose wording admins can override per fund. Drives
// both the settings editor UI and server-side validation. Keep keys aligned
// with the EmailType enum (prisma) — only the types listed here are editable.
//
// `i18nKey`    — the message namespace holding the built-in default (the
//                fallback when a fund has no override).
// `variables`  — the {placeholder} tokens the subject/body may reference;
//                anything outside this set is rejected on save so we never
//                ship a template that renders a broken `{token}`.
// `hasCta`     — whether this template renders a CTA button (a bare-URL line
//                in the body). ALLOCATION_CONFIRMATION has none.
// `defaultIsHtml` — whether the built-in i18n default is authored as rich HTML
//                (key `bodyHtml`) rather than plain text (key `textBody`). HTML
//                defaults are used verbatim in the editor; text defaults are
//                upgraded via plainTextToHtml.
export const EDITABLE_EMAIL_TEMPLATES = {
  ALLOCATION_CONFIRMATION: {
    i18nKey: "members.email.allocationConfirmation",
    hasCta: false,
    defaultIsHtml: false,
    // `shopList` is a "rich" variable: it expands to a bulleted list of the
    // fund's active merchants (HTML <ul> in the HTML body, dashed lines in the
    // text part). The rest are plain scalars. See services/email/templates.ts.
    variables: [
      "firstName",
      "lastName",
      "fundName",
      "amount",
      "cardSerial",
      "shopList",
    ],
  },
  CARD_ASSIGNED: {
    i18nKey: "members.email.cardAssigned",
    hasCta: false,
    defaultIsHtml: true,
    // All plain scalars, resolved by the caller (notify action / test send):
    // {address} is the member's formatted postal address, {cardLink} the public
    // tap URL, {cardNumber} the per-fund card number. See templates.ts.
    variables: [
      "firstName",
      "lastName",
      "fundName",
      "address",
      "cardLink",
      "cardNumber",
    ],
  },
  PAYMENT_REMINDER_FIRST: {
    // i18nKey is structural only — HTML-defaulted templates take their default
    // from the constant in templates.ts, never from i18n (see htmlTemplateDefault).
    i18nKey: "members.email.paymentReminder",
    hasCta: false,
    defaultIsHtml: true,
    // Plain scalars resolved by the caller (cron / test send): {amount} is the
    // member's monthly contribution (tier minimum), {paymentReference} the bank
    // transfer communication that bank-sync matches on (the card UID), {cardLink}
    // the public account/tap URL. See templates.ts.
    variables: [
      "firstName",
      "lastName",
      "fundName",
      "amount",
      "paymentReference",
      "cardLink",
    ],
  },
} as const;

export type EditableEmailType = keyof typeof EDITABLE_EMAIL_TEMPLATES;

// Placeholder values used to render the live editor preview, so the admin sees
// realistic output. fundName is overridden with the real fund name at preview
// time; the rest are illustrative samples.
export const PREVIEW_SAMPLE_VALUES: Record<
  EditableEmailType,
  Record<string, string>
> = {
  ALLOCATION_CONFIRMATION: {
    firstName: "Alex",
    lastName: "Dupont",
    fundName: "Your fund",
    amount: "25",
    cardSerial: "04A2B7C9D1",
  },
  CARD_ASSIGNED: {
    firstName: "Alex",
    lastName: "Dupont",
    fundName: "Your fund",
    address: "Rue de l'Exemple 12, 1000 Bruxelles",
    cardLink: "https://tap.citizenpay.xyz/card/04A2B7C9D1?network=demo",
    cardNumber: "42",
  },
  PAYMENT_REMINDER_FIRST: {
    firstName: "Alex",
    lastName: "Dupont",
    fundName: "Your fund",
    amount: "25",
    // The reference is the card UID (serialNumber); mirror the sample serial.
    paymentReference: "04A2B7C9D1",
    cardLink: "https://tap.citizenpay.xyz/card/04A2B7C9D1?network=demo",
  },
};

export const EDITABLE_EMAIL_TYPES = Object.keys(
  EDITABLE_EMAIL_TEMPLATES,
) as EditableEmailType[];

export function isEditableEmailType(value: string): value is EditableEmailType {
  return value in EDITABLE_EMAIL_TEMPLATES;
}

// Zod schema for the save action. Subject one line, body is rich HTML; both
// required. `type` is constrained to the editable set. Error messages are
// i18n keys (resolved by the caller), matching the settings-actions pattern.
export const SaveEmailTemplateSchema = z.object({
  type: z.enum(
    EDITABLE_EMAIL_TYPES as [EditableEmailType, ...EditableEmailType[]],
  ),
  // The language this override applies to. Each language is edited independently.
  locale: z.enum(
    SUPPORTED_LOCALES as unknown as [string, ...string[]],
  ),
  subject: z
    .string()
    .trim()
    .min(1, { error: "fund.settings.emailTemplates.errors.subjectRequired" })
    .max(200, { error: "fund.settings.emailTemplates.errors.subjectTooLong" }),
  bodyHtml: z
    .string()
    .trim()
    .min(1, { error: "fund.settings.emailTemplates.errors.bodyRequired" })
    .max(20000, { error: "fund.settings.emailTemplates.errors.bodyTooLong" }),
});

export type SaveEmailTemplateInput = z.infer<typeof SaveEmailTemplateSchema>;

// Input shape for the live preview (no length constraints — it's transient).
export const PreviewEmailTemplateSchema = z.object({
  type: z.enum(
    EDITABLE_EMAIL_TYPES as [EditableEmailType, ...EditableEmailType[]],
  ),
  // Accepted for symmetry with the save input; preview interpolates the
  // client-supplied body directly, so the locale doesn't change the output.
  locale: z.enum(SUPPORTED_LOCALES as unknown as [string, ...string[]]),
  subject: z.string(),
  bodyHtml: z.string(),
});

export type PreviewEmailTemplateInput = z.infer<
  typeof PreviewEmailTemplateSchema
>;

// All distinct {token} names referenced in a string.
export function extractPlaceholders(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/\{(\w+)\}/g)) found.add(m[1]);
  return [...found];
}

// {token}s used in subject+body that aren't in the template's allowed set.
// Used by the save action to block broken templates before they're stored.
export function findUnknownPlaceholders(
  type: EditableEmailType,
  subject: string,
  body: string,
): string[] {
  const allowed = new Set<string>(EDITABLE_EMAIL_TEMPLATES[type].variables);
  const used = new Set([
    ...extractPlaceholders(subject),
    ...extractPlaceholders(body),
  ]);
  return [...used].filter((name) => !allowed.has(name));
}
