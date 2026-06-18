// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { getLocale, getTranslations } from "next-intl/server";

import { prisma } from "@/services/db/prisma";
import { DEFAULT_LOCALE } from "@/services/i18n/config";
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
  vars: {
    firstName: string;
    lastName: string;
    fundName: string;
    amount: string;
  };
}): Promise<Rendered> {
  const override = await prisma.emailTemplate.findUnique({
    where: {
      fundId_type: { fundId: args.fundId, type: "ALLOCATION_CONFIRMATION" },
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
  const t = await getTranslations(
    EDITABLE_EMAIL_TEMPLATES.ALLOCATION_CONFIRMATION.i18nKey,
  );
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

function htmlTemplateDefault(
  type: EditableEmailType,
  locale: string,
): { subject: string; bodyHtml: string } {
  // Only CARD_ASSIGNED has an HTML default today; the registry's defaultIsHtml
  // flag gates callers so this is never reached for a text-defaulted template.
  const byLocale = type === "CARD_ASSIGNED" ? CARD_ASSIGNED_DEFAULTS : {};
  return byLocale[locale] ?? byLocale[DEFAULT_LOCALE] ?? byLocale.fr;
}

// The CARD_ASSIGNED ("your card is on its way") email. Same override-or-default
// shape as the allocation template, but every variable is a plain scalar the
// caller resolves up-front (the notify action / test send): {address} is the
// member's formatted postal address, {cardLink} the public tap URL, {cardNumber}
// the per-fund card number. The built-in default is authored as rich HTML.
export async function resolveCardAssignedTemplate(args: {
  fundId: string;
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
    where: { fundId_type: { fundId: args.fundId, type: "CARD_ASSIGNED" } },
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

  const def = htmlTemplateDefault("CARD_ASSIGNED", await getLocale());
  const html = interpolate(def.bodyHtml, args.vars);
  return {
    subject: interpolate(def.subject, args.vars),
    text: htmlToPlainText(html),
    html,
  };
}

// For the settings editor: the saved override (if any) plus the built-in
// default, both as HTML with {placeholders} left literal so the admin sees
// which tokens are available. "Reset to default" drops the override and falls
// back to the base. Generic over the editable template type.
export async function getEmailTemplateForEditing(args: {
  type: EditableEmailType;
  fund: { id: string; defaultLocale: string };
}): Promise<{
  override: { subject: string; bodyHtml: string } | null;
  base: { subject: string; bodyHtml: string };
  variables: readonly string[];
}> {
  const config = EDITABLE_EMAIL_TEMPLATES[args.type];

  const stored = await prisma.emailTemplate.findUnique({
    where: { fundId_type: { fundId: args.fund.id, type: args.type } },
    select: { subject: true, bodyText: true, bodyHtml: true },
  });

  const locale =
    args.fund.defaultLocale && args.fund.defaultLocale.length > 0
      ? args.fund.defaultLocale
      : DEFAULT_LOCALE;

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
