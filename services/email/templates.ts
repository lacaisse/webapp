// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { getTranslations } from "next-intl/server";

import { prisma } from "@/services/db/prisma";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "@/services/i18n/config";
import {
  EDITABLE_EMAIL_TEMPLATES,
  type EditableEmailType,
} from "./template-config";

// Base of the public card "tap" page. Matches the CitizenPay API's own redirect
// (`{TAP_BASE_URL}/card/<serial>?network=<treasury-slug>`); overridable via env
// for non-prod tap deployments.
const TAP_BASE_URL = (
  process.env.CITIZENPAY_TAP_BASE_URL || "https://tap.citizenpay.xyz"
).replace(/\/+$/, "");

// The member-facing public URL for a card: the CARD_ASSIGNED {cardLink}. `slug`
// is the fund's cached CitizenPay treasury slug (Fund.citizenPayTreasurySlug);
// when absent the link still resolves to the card page without the network hint.
export function buildCardLink(
  serialNumber: string,
  slug: string | null,
): string {
  const base = `${TAP_BASE_URL}/card/${encodeURIComponent(serialNumber)}`;
  return slug ? `${base}?network=${encodeURIComponent(slug)}` : base;
}

// One-line postal address from a member's address parts, skipping blanks.
export function formatMemberAddress(member: {
  address: string | null;
  postalCode: string | null;
  city: string | null;
}): string {
  const cityLine = [member.postalCode, member.city]
    .map((s) => s?.trim())
    .filter(Boolean)
    .join(" ");
  return [member.address?.trim(), cityLine].filter(Boolean).join(", ");
}

// Resolves an email's wording, preferring a fund's saved override over the
// built-in i18n default. The override is a single template per fund (no
// per-locale variants yet) with {placeholder} tokens interpolated here. The
// body can be rich HTML (injected into the branded shell) or plain text.

// Replace {token} with vars[token]. Unknown tokens are left literal (the save
// validation already rejects those, so this only guards against drift).
export function interpolate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? vars[name] : whole,
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Wrap a plain-text body as simple HTML: blank-line-separated paragraphs, with
// single newlines as <br>. Used to seed the HTML editor from the plain-text
// default (and to upgrade legacy plain-text overrides). Placeholders pass
// through untouched.
export function plainTextToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map(
      (block) =>
        `<p>${escapeHtml(block).replace(/\n/g, "<br />")}</p>`,
    )
    .join("\n");
}

// Best-effort plain-text rendering of an HTML body, for the text/plain MIME
// part + the stored bodyText snapshot. Not a full HTML parser — enough to keep
// a readable text alternative.
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<\s*(br|\/p|\/div|\/h[1-6]|\/li)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// The fund's active, publicly-visible merchants, formatted as a {shopList}
// value — an HTML <ul> for the HTML body and dashed lines for the text part.
// Merchants flagged not publicly visible are excluded. Empty when the fund has
// no listable merchants yet.
export async function buildShopList(
  fundId: string,
): Promise<{ html: string; text: string }> {
  const merchants = await prisma.merchant.findMany({
    where: { fundId, status: "ACTIVE", publiclyVisible: true },
    select: { name: true, city: true },
    orderBy: { name: "asc" },
  });
  if (merchants.length === 0) return { html: "", text: "" };

  const text = merchants
    .map((m) => `- ${m.name}${m.city ? `, ${m.city}` : ""}`)
    .join("\n");
  const html =
    "<ul>" +
    merchants
      .map(
        (m) =>
          `<li>${escapeHtml(m.name)}${
            m.city ? ` — ${escapeHtml(m.city)}` : ""
          }</li>`,
      )
      .join("") +
    "</ul>";
  return { html, text };
}

// The card serial for a recipient wallet address (TokenOperation.account).
async function resolveCardSerial(account: string | null): Promise<string> {
  if (!account) return "";
  const card = await prisma.card.findUnique({
    where: { account },
    select: { serialNumber: true },
  });
  return card?.serialNumber ?? "";
}

type Rendered = { subject: string; text: string; html?: string };

// The ALLOCATION_CONFIRMATION email body. Uses the fund's override if present
// (HTML body when authored, else its plain text), otherwise the i18n default.
// Member/fund-scoped variables (cardSerial, shopList) are resolved lazily —
// only fetched when the template actually references them.
export async function resolveAllocationTemplate(args: {
  fundId: string;
  account: string | null;
  // Recipient's language for the built-in default (overrides are single-locale).
  locale: string;
  vars: {
    firstName: string;
    lastName: string;
    fundName: string;
    amount: string;
  };
}): Promise<Rendered> {
  const override = await prisma.emailTemplate.findUnique({
    where: {
      fundId_type_locale: {
        fundId: args.fundId,
        type: "ALLOCATION_CONFIRMATION",
        locale: args.locale,
      },
    },
    select: { subject: true, bodyText: true, bodyHtml: true },
  });

  if (override) {
    const scan = `${override.subject}\n${override.bodyText}\n${
      override.bodyHtml ?? ""
    }`;
    const cardSerial = scan.includes("{cardSerial}")
      ? await resolveCardSerial(args.account)
      : "";
    const shop = scan.includes("{shopList}")
      ? await buildShopList(args.fundId)
      : { html: "", text: "" };

    const scalar = { ...args.vars, cardSerial };
    const varsText = { ...scalar, shopList: shop.text };
    const varsHtml = { ...scalar, shopList: shop.html };
    return {
      subject: interpolate(override.subject, varsText),
      text: interpolate(override.bodyText, varsText),
      html: override.bodyHtml
        ? interpolate(override.bodyHtml, varsHtml)
        : undefined,
    };
  }

  // Built-in default references only firstName/fundName/amount.
  const t = await getTranslations({
    locale: args.locale,
    namespace: EDITABLE_EMAIL_TEMPLATES.ALLOCATION_CONFIRMATION.i18nKey,
  });
  return {
    subject: t("subject", { fundName: args.vars.fundName }),
    text: t("textBody", {
      firstName: args.vars.firstName,
      fundName: args.vars.fundName,
      amount: args.vars.amount,
    }),
  };
}

// Built-in HTML defaults can't live in next-intl messages: ICU MessageFormat
// parses `<tag>` as rich-text markup and throws INVALID_TAG on raw HTML. So the
// HTML-bodied template defaults live here as per-locale constants, interpolated
// with our brace-token interpolate() (no ICU). {tokens} are left literal in the
// source; they're substituted at render (or kept literal for the editor).
const CARD_ASSIGNED_DEFAULTS: Record<
  string,
  { subject: string; bodyHtml: string }
> = {
  fr: {
    subject: "Votre carte {fundName} est en route !",
    bodyHtml: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
  <h1 style="color: hsl(25, 95%, 53%);">Votre carte {fundName} est en route !</h1>
  <p>Bonjour {firstName} {lastName},</p>
  <p>Nous avons le plaisir de vous informer que votre carte {fundName} a été préparée et sera bientôt envoyée à l'adresse suivante :</p>
  <div style="background-color: #f3f4f6; padding: 15px; border-radius: 8px; margin: 20px 0;">
    <p style="margin: 0; font-weight: bold;">{address}</p>
  </div>
  <p>Vous pourrez consulter les détails de votre carte en cliquant sur le lien ci-dessous :</p>
  <div style="text-align: center; margin: 30px 0;">
    <a href="{cardLink}" style="background-color: hsl(25, 95%, 53%); color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Voir ma carte {fundName}</a>
  </div>
  <p style="color: #6b7280; font-size: 14px;">Numéro de carte : {cardNumber}</p>
  <p>À bientôt,<br>L'équipe {fundName}</p>
</div>`,
  },
  en: {
    subject: "Your {fundName} card is on its way!",
    bodyHtml: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
  <h1 style="color: hsl(25, 95%, 53%);">Your {fundName} card is on its way!</h1>
  <p>Hi {firstName} {lastName},</p>
  <p>We're pleased to let you know that your {fundName} card has been prepared and will soon be sent to the following address:</p>
  <div style="background-color: #f3f4f6; padding: 15px; border-radius: 8px; margin: 20px 0;">
    <p style="margin: 0; font-weight: bold;">{address}</p>
  </div>
  <p>You can view your card details using the link below:</p>
  <div style="text-align: center; margin: 30px 0;">
    <a href="{cardLink}" style="background-color: hsl(25, 95%, 53%); color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">View my {fundName} card</a>
  </div>
  <p style="color: #6b7280; font-size: 14px;">Card number: {cardNumber}</p>
  <p>See you soon,<br>The {fundName} team</p>
</div>`,
  },
};

// The PAYMENT_REMINDER_FIRST ("monthly payment request") default. Adapted from
// La CLASS's template (issue #39) but tenant-neutral: no fund-specific copy,
// and — since this platform reconciles contributions by bank transfer matched
// on the member's reference, not an online checkout — it shows the bank-transfer
// {paymentReference} instead of a "pay now" button. Colours are kept neutral
// (the brand colour is only applied to text-mode CTAs, not HTML bodies).
const PAYMENT_REMINDER_DEFAULTS: Record<
  string,
  { subject: string; bodyHtml: string }
> = {
  fr: {
    subject: "Votre cotisation mensuelle — {fundName}",
    bodyHtml: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
  <p>Bonjour {firstName},</p>
  <p>Un mois de plus pour soutenir collectivement une alimentation de qualité, accessible à toutes et tous !</p>
  <div style="background-color: #f3f4f6; padding: 20px; margin: 20px 0; border-radius: 8px;">
    <h3 style="margin-top: 0;">Détails de votre cotisation</h3>
    <p style="margin: 8px 0;"><strong>Cotisation mensuelle :</strong> {amount} €</p>
  </div>
  <p>Pour effectuer votre cotisation, faites un virement bancaire en indiquant bien la communication suivante, afin que votre paiement soit reconnu automatiquement :</p>
  <div style="background-color: #f1eee8; padding: 12px 16px; border-radius: 8px; margin: 20px 0; font-family: monospace; font-size: 16px; word-break: break-word;">{paymentReference}</div>
  <p>Vous pouvez retrouver les informations de votre compte {fundName} <a href="{cardLink}" style="color: #2563eb;">à cette adresse</a>.</p>
  <p>Merci pour votre soutien, et à bientôt,<br><strong>L'équipe {fundName}</strong></p>
</div>`,
  },
  en: {
    subject: "Your monthly contribution — {fundName}",
    bodyHtml: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
  <p>Hi {firstName},</p>
  <p>Another month to collectively support quality food that's accessible to everyone!</p>
  <div style="background-color: #f3f4f6; padding: 20px; margin: 20px 0; border-radius: 8px;">
    <h3 style="margin-top: 0;">Your contribution</h3>
    <p style="margin: 8px 0;"><strong>Monthly contribution:</strong> {amount} €</p>
  </div>
  <p>To make your contribution, send a bank transfer with the following reference so your payment is recognised automatically:</p>
  <div style="background-color: #f1eee8; padding: 12px 16px; border-radius: 8px; margin: 20px 0; font-family: monospace; font-size: 16px; word-break: break-word;">{paymentReference}</div>
  <p>You can find your {fundName} account details <a href="{cardLink}" style="color: #2563eb;">at this link</a>.</p>
  <p>Thanks for your support, and see you soon,<br><strong>The {fundName} team</strong></p>
</div>`,
  },
};

function htmlTemplateDefault(
  type: EditableEmailType,
  locale: string,
): { subject: string; bodyHtml: string } {
  // Registry's defaultIsHtml flag gates callers, so this is only reached for
  // HTML-defaulted templates. Each maps to its per-locale default constant.
  const byLocale =
    type === "CARD_ASSIGNED"
      ? CARD_ASSIGNED_DEFAULTS
      : type === "PAYMENT_REMINDER_FIRST"
        ? PAYMENT_REMINDER_DEFAULTS
        : {};
  return byLocale[locale] ?? byLocale[DEFAULT_LOCALE] ?? byLocale.fr;
}

// The CARD_ASSIGNED ("your card is on its way") email. Same override-or-default
// shape as the allocation template, but every variable is a plain scalar the
// caller resolves up-front (the notify action / test send): {address} is the
// member's formatted postal address, {cardLink} the public tap URL, {cardNumber}
// the per-fund card number. The built-in default is authored as rich HTML.
export async function resolveCardAssignedTemplate(args: {
  fundId: string;
  // Recipient's language for the built-in default (overrides are single-locale).
  locale: string;
  vars: {
    firstName: string;
    lastName: string;
    fundName: string;
    address: string;
    cardLink: string;
    cardNumber: string;
  };
}): Promise<Rendered> {
  const override = await prisma.emailTemplate.findUnique({
    where: {
      fundId_type_locale: {
        fundId: args.fundId,
        type: "CARD_ASSIGNED",
        locale: args.locale,
      },
    },
    select: { subject: true, bodyText: true, bodyHtml: true },
  });

  if (override) {
    return {
      subject: interpolate(override.subject, args.vars),
      text: interpolate(override.bodyText, args.vars),
      html: override.bodyHtml
        ? interpolate(override.bodyHtml, args.vars)
        : undefined,
    };
  }

  const def = htmlTemplateDefault("CARD_ASSIGNED", args.locale);
  const html = interpolate(def.bodyHtml, args.vars);
  return {
    subject: interpolate(def.subject, args.vars),
    text: htmlToPlainText(html),
    html,
  };
}

// The PAYMENT_REMINDER_FIRST email. Same override-or-default shape as
// CARD_ASSIGNED — every variable is a plain scalar the caller resolves up front
// (the reminder cron / test send): {amount} the member's monthly contribution,
// {paymentReference} the bank-transfer communication, {cardLink} the public
// account URL. The built-in default is authored as rich HTML.
export async function resolvePaymentReminderTemplate(args: {
  fundId: string;
  // Recipient's language for the built-in default (overrides are single-locale).
  locale: string;
  vars: {
    firstName: string;
    lastName: string;
    fundName: string;
    amount: string;
    paymentReference: string;
    cardLink: string;
  };
}): Promise<Rendered> {
  const override = await prisma.emailTemplate.findUnique({
    where: {
      fundId_type_locale: {
        fundId: args.fundId,
        type: "PAYMENT_REMINDER_FIRST",
        locale: args.locale,
      },
    },
    select: { subject: true, bodyText: true, bodyHtml: true },
  });

  if (override) {
    return {
      subject: interpolate(override.subject, args.vars),
      text: interpolate(override.bodyText, args.vars),
      html: override.bodyHtml
        ? interpolate(override.bodyHtml, args.vars)
        : undefined,
    };
  }

  const def = htmlTemplateDefault("PAYMENT_REMINDER_FIRST", args.locale);
  const html = interpolate(def.bodyHtml, args.vars);
  return {
    subject: interpolate(def.subject, args.vars),
    text: htmlToPlainText(html),
    html,
  };
}

// One editable locale's state: the saved override for that language (if any)
// plus the built-in default for it, both as HTML with {placeholders} left
// literal so the admin sees which tokens are available.
export type EditableTemplateLocale = {
  override: { subject: string; bodyHtml: string } | null;
  base: { subject: string; bodyHtml: string };
};

// For the template editor: a single language's saved override (if any) plus the
// built-in default for that language. "Reset to default" drops the override and
// falls back to the base. Generic over the editable template type.
export async function getEmailTemplateForEditing(args: {
  type: EditableEmailType;
  fundId: string;
  // The language being edited (SUPPORTED_LOCALES). Each language is independent.
  locale: string;
}): Promise<EditableTemplateLocale & { variables: readonly string[] }> {
  const config = EDITABLE_EMAIL_TEMPLATES[args.type];

  const stored = await prisma.emailTemplate.findUnique({
    where: {
      fundId_type_locale: {
        fundId: args.fundId,
        type: args.type,
        locale: args.locale,
      },
    },
    select: { subject: true, bodyText: true, bodyHtml: true },
  });

  const locale = args.locale.length > 0 ? args.locale : DEFAULT_LOCALE;

  // HTML-defaulted templates keep their {tokens} literal in the source constant,
  // so the editor shows them verbatim. Text-defaulted templates render the i18n
  // default feeding each variable its own brace token back, then upgrade to HTML.
  let base: { subject: string; bodyHtml: string };
  if (config.defaultIsHtml) {
    base = htmlTemplateDefault(args.type, locale);
  } else {
    const t = await getTranslations({ locale, namespace: config.i18nKey });
    const literalVars = Object.fromEntries(
      config.variables.map((v) => [v, `{${v}}`]),
    );
    base = {
      subject: t("subject", literalVars),
      bodyHtml: plainTextToHtml(t("textBody", literalVars)),
    };
  }

  const override = stored
    ? {
        subject: stored.subject,
        // HTML body if authored; otherwise upgrade the legacy plain-text
        // override so the editor always works in HTML.
        bodyHtml: stored.bodyHtml ?? plainTextToHtml(stored.bodyText),
      }
    : null;

  return { override, base, variables: config.variables };
}

// All editable locales for a template in one pass, keyed by locale — the shape
// the per-language editor consumes. `variables` is shared across locales.
export async function getEmailTemplatesForEditing(args: {
  type: EditableEmailType;
  fundId: string;
}): Promise<{
  byLocale: Record<string, EditableTemplateLocale>;
  variables: readonly string[];
}> {
  const results = await Promise.all(
    SUPPORTED_LOCALES.map(async (locale) => {
      const { override, base } = await getEmailTemplateForEditing({
        type: args.type,
        fundId: args.fundId,
        locale,
      });
      return [locale, { override, base }] as const;
    }),
  );
  return {
    byLocale: Object.fromEntries(results),
    variables: EDITABLE_EMAIL_TEMPLATES[args.type].variables,
  };
}
