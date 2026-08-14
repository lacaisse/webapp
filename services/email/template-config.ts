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
    // tap URL, {cardNumber} the per-fund card number, {paymentReference} the
    // card's serial (the bank-transfer reference bank-sync matches on — same
    // value as the MEMBER_ACTIVATED/PAYMENT_REMINDER templates), {iban} the
    // fund's connected bank account IBAN (blank if not yet bank-connected).
    // See templates.ts.
    variables: [
      "firstName",
      "lastName",
      "fundName",
      "address",
      "cardLink",
      "cardNumber",
      "paymentReference",
      "iban",
    ],
  },
  PAYMENT_REMINDER_FIRST: {
    // i18nKey is structural only — HTML-defaulted templates take their default
    // from the constant in templates.ts, never from i18n (see htmlTemplateDefault).
    i18nKey: "members.email.paymentReminder",
    hasCta: false,
    defaultIsHtml: true,
    // Plain scalars resolved by the caller (cron / test send): {amount} is the
    // member's monthly contribution, {paymentReference} the bank transfer
    // communication that bank-sync matches on (the card UID), {cardLink} the
    // public account/tap URL, {paymentLink} the public /pay/<serial> page that
    // shows the member how to pay this contribution. See templates.ts.
    variables: [
      "firstName",
      "lastName",
      "fundName",
      "amount",
      "paymentReference",
      "cardLink",
      "paymentLink",
    ],
  },
  // The admin's manual follow-up nudge (services/allocation-periods). Shares the
  // FIRST reminder's variables but has its own HTML default so admins can give
  // it a distinct, firmer tone. See PAYMENT_REMINDER_SECOND_DEFAULTS.
  PAYMENT_REMINDER_SECOND: {
    i18nKey: "members.email.paymentReminder",
    hasCta: false,
    defaultIsHtml: true,
    variables: [
      "firstName",
      "lastName",
      "fundName",
      "amount",
      "paymentReference",
      "cardLink",
      "paymentLink",
    ],
  },
  // Text-defaulted informational emails. Each variable set matches exactly what
  // the corresponding sender in services/email/transactional.ts passes — adding
  // a token outside this set is rejected on save (it would render literally).
  MEMBER_WELCOME: {
    i18nKey: "members.signup.emailTemplates.welcome",
    hasCta: false,
    defaultIsHtml: false,
    variables: ["firstName", "fundName"],
  },
  MEMBER_INVITED: {
    i18nKey: "members.admin.email.invited",
    hasCta: false,
    defaultIsHtml: false,
    variables: ["firstName", "fundName"],
  },
  MEMBER_ACTIVATED: {
    i18nKey: "members.admin.email.activated",
    hasCta: false,
    defaultIsHtml: false,
    variables: ["firstName", "fundName", "cardSerial", "paymentReference"],
  },
  PAYMENT_CONFIRMATION: {
    i18nKey: "members.email.paymentConfirmation",
    hasCta: false,
    defaultIsHtml: false,
    variables: ["firstName", "fundName", "amount", "occurredAt"],
  },
  PAYMENT_BELOW_MINIMUM: {
    i18nKey: "members.email.paymentBelowMinimum",
    hasCta: false,
    defaultIsHtml: false,
    // Editable because the built-in default states a payout calendar ("versés
    // le 15 du mois", "avant le 9 du mois") that is one fund's policy, not a
    // platform rule — every other fund needs to be able to correct it without
    // a code change. {minContribution} is the tier's minimum, {allocationAmount}
    // the allocation that minimum unlocks, {amount} what actually arrived.
    variables: [
      "firstName",
      "lastName",
      "fundName",
      "amount",
      "minContribution",
      "allocationAmount",
      "occurredAt",
    ],
  },
  REFERRAL_BONUS_AWARDED: {
    i18nKey: "members.admin.email.referralBonusAwarded",
    hasCta: false,
    defaultIsHtml: false,
    variables: ["firstName", "fundName", "amount"],
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
    // The reference is the card UID (serialNumber); mirror the sample serial.
    paymentReference: "04A2B7C9D1",
    // Illustrative only — the real send resolves the fund's actual connected
    // bank account IBAN (blank if not yet bank-connected).
    iban: "BE71 0961 2345 6769",
  },
  PAYMENT_REMINDER_FIRST: {
    firstName: "Alex",
    lastName: "Dupont",
    fundName: "Your fund",
    amount: "25",
    // The reference is the card UID (serialNumber); mirror the sample serial.
    paymentReference: "04A2B7C9D1",
    cardLink: "https://tap.citizenpay.xyz/card/04A2B7C9D1?network=demo",
    paymentLink: "https://demo.lacaisse.eu/pay/04A2B7C9D1",
  },
  PAYMENT_REMINDER_SECOND: {
    firstName: "Alex",
    lastName: "Dupont",
    fundName: "Your fund",
    amount: "25",
    paymentReference: "04A2B7C9D1",
    cardLink: "https://tap.citizenpay.xyz/card/04A2B7C9D1?network=demo",
    paymentLink: "https://demo.lacaisse.eu/pay/04A2B7C9D1",
  },
  MEMBER_WELCOME: {
    firstName: "Alex",
    fundName: "Your fund",
  },
  MEMBER_INVITED: {
    firstName: "Alex",
    fundName: "Your fund",
  },
  MEMBER_ACTIVATED: {
    firstName: "Alex",
    fundName: "Your fund",
    cardSerial: "04A2B7C9D1",
    paymentReference: "04A2B7C9D1",
  },
  PAYMENT_CONFIRMATION: {
    firstName: "Alex",
    fundName: "Your fund",
    amount: "25",
    occurredAt: "24/07/2026",
  },
  PAYMENT_BELOW_MINIMUM: {
    firstName: "Alex",
    lastName: "Dupont",
    fundName: "Your fund",
    amount: "15",
    minContribution: "25",
    allocationAmount: "50",
    occurredAt: "24/07/2026",
  },
  REFERRAL_BONUS_AWARDED: {
    firstName: "Alex",
    fundName: "Your fund",
    amount: "10",
  },
};

export const EDITABLE_EMAIL_TYPES = Object.keys(
  EDITABLE_EMAIL_TEMPLATES,
) as EditableEmailType[];

export function isEditableEmailType(value: string): value is EditableEmailType {
  return value in EDITABLE_EMAIL_TEMPLATES;
}

const editableTypeEnum = z.enum(
  EDITABLE_EMAIL_TYPES as [EditableEmailType, ...EditableEmailType[]],
);
const localeEnum = z.enum(SUPPORTED_LOCALES as unknown as [string, ...string[]]);

// Create a new library template for a type, either from the built-in default
// (sourceTemplateId null) or by duplicating an existing template's content.
export const CreateEmailTemplateSchema = z.object({
  type: editableTypeEnum,
  name: z
    .string()
    .trim()
    .min(1, { error: "fund.settings.emailTemplates.errors.nameRequired" })
    .max(80, { error: "fund.settings.emailTemplates.errors.nameTooLong" }),
  // The template to copy content from; null seeds from the built-in default.
  sourceTemplateId: z.string().min(1).nullable(),
});

export type CreateEmailTemplateInput = z.infer<typeof CreateEmailTemplateSchema>;

// Save one language's content of a library template. Subject one line, body is
// rich HTML; both required. Error messages are i18n keys (resolved by the
// caller), matching the settings-actions pattern.
export const SaveTemplateLocalizationSchema = z.object({
  templateId: z.string().min(1),
  type: editableTypeEnum,
  locale: localeEnum,
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

export type SaveTemplateLocalizationInput = z.infer<
  typeof SaveTemplateLocalizationSchema
>;

export const RenameEmailTemplateSchema = z.object({
  templateId: z.string().min(1),
  name: z
    .string()
    .trim()
    .min(1, { error: "fund.settings.emailTemplates.errors.nameRequired" })
    .max(80, { error: "fund.settings.emailTemplates.errors.nameTooLong" }),
});

export type RenameEmailTemplateInput = z.infer<
  typeof RenameEmailTemplateSchema
>;

// Set which template is active for a type. templateId null = revert to the
// built-in default.
export const AssignEmailTemplateSchema = z.object({
  type: editableTypeEnum,
  templateId: z.string().min(1).nullable(),
});

export type AssignEmailTemplateInput = z.infer<
  typeof AssignEmailTemplateSchema
>;

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
