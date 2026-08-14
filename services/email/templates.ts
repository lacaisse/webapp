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

// Email wording resolves to the fund's active library template for a type (per
// language), falling back to the built-in default when no template is assigned
// or the assigned one has no content for the recipient's language. {placeholder}
// tokens are interpolated here; the body can be rich HTML (injected into the
// branded shell) or plain text. See loadActiveTemplateContent below.

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

// Raw (uninterpolated) content for one email in one language — either an active
// library template's localization or the built-in default. {tokens} are left
// literal; the caller interpolates. bodyHtml null = plain-text-only default.
export type EmailContent = {
  subject: string;
  bodyText: string;
  bodyHtml: string | null;
};

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
  <p style="color: #6b7280; font-size: 14px;">Référence de paiement : {paymentReference}</p>
  <p style="color: #6b7280; font-size: 14px;">IBAN : {iban}</p>
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
  <p style="color: #6b7280; font-size: 14px;">Payment reference: {paymentReference}</p>
  <p style="color: #6b7280; font-size: 14px;">IBAN: {iban}</p>
  <p>See you soon,<br>The {fundName} team</p>
</div>`,
  },
};

// The PAYMENT_REMINDER_FIRST ("monthly payment request") default. Adapted from
// La CLASS's template (issue #39) but tenant-neutral: no fund-specific copy,
// and — since this platform reconciles contributions by bank transfer matched
// on the member's reference, not an online checkout — it points the member at
// their public payment page ({paymentLink}, app/(fund-public)/pay/[serial])
// rather than restating the reference inline. That page already shows the
// beneficiary, IBAN, reference and EPC QR, so the email stays short and in sync.
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
  <p>Pour effectuer votre cotisation, rendez-vous sur votre page de paiement : vous y trouverez le bénéficiaire, l'IBAN, la référence à indiquer et un QR code à scanner depuis votre application bancaire.</p>
  <div style="text-align: center; margin: 30px 0;">
    <a href="{paymentLink}" style="background-color: #111827; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Payer ma cotisation</a>
  </div>
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
  <p>To make your contribution, head to your payment page: you'll find the beneficiary, IBAN, the reference to include, and a QR code you can scan from your banking app.</p>
  <div style="text-align: center; margin: 30px 0;">
    <a href="{paymentLink}" style="background-color: #111827; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Pay my contribution</a>
  </div>
  <p>Thanks for your support, and see you soon,<br><strong>The {fundName} team</strong></p>
</div>`,
  },
};

// The PAYMENT_REMINDER_SECOND default — the admin's manual follow-up nudge. A
// firmer, shorter tone than the first reminder; same {paymentLink} CTA so it
// stays in sync with the member's public payment page.
const PAYMENT_REMINDER_SECOND_DEFAULTS: Record<
  string,
  { subject: string; bodyHtml: string }
> = {
  fr: {
    subject: "Rappel : votre cotisation — {fundName}",
    bodyHtml: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
  <p>Bonjour {firstName},</p>
  <p>Nous n'avons pas encore reçu votre cotisation pour cette période. Un petit rappel amical !</p>
  <div style="background-color: #f3f4f6; padding: 20px; margin: 20px 0; border-radius: 8px;">
    <h3 style="margin-top: 0;">Détails de votre cotisation</h3>
    <p style="margin: 8px 0;"><strong>Cotisation mensuelle :</strong> {amount} €</p>
  </div>
  <p>Pour régulariser, rendez-vous sur votre page de paiement : vous y trouverez le bénéficiaire, l'IBAN, la référence à indiquer et un QR code à scanner depuis votre application bancaire.</p>
  <div style="text-align: center; margin: 30px 0;">
    <a href="{paymentLink}" style="background-color: #111827; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Payer ma cotisation</a>
  </div>
  <p>Merci pour votre soutien,<br><strong>L'équipe {fundName}</strong></p>
</div>`,
  },
  en: {
    subject: "Reminder: your contribution — {fundName}",
    bodyHtml: `<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
  <p>Hi {firstName},</p>
  <p>We haven't received your contribution for this period yet — just a friendly reminder!</p>
  <div style="background-color: #f3f4f6; padding: 20px; margin: 20px 0; border-radius: 8px;">
    <h3 style="margin-top: 0;">Your contribution</h3>
    <p style="margin: 8px 0;"><strong>Monthly contribution:</strong> {amount} €</p>
  </div>
  <p>To catch up, head to your payment page: you'll find the beneficiary, IBAN, the reference to include, and a QR code you can scan from your banking app.</p>
  <div style="text-align: center; margin: 30px 0;">
    <a href="{paymentLink}" style="background-color: #111827; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">Pay my contribution</a>
  </div>
  <p>Thanks for your support,<br><strong>The {fundName} team</strong></p>
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
        : type === "PAYMENT_REMINDER_SECOND"
          ? PAYMENT_REMINDER_SECOND_DEFAULTS
          : {};
  return byLocale[locale] ?? byLocale[DEFAULT_LOCALE] ?? byLocale.fr;
}

// The built-in default content for a type+language, with {tokens} left literal.
// HTML-defaulted types read their per-locale constant; text-defaulted types
// render the i18n default feeding each variable its own brace token back, so
// the tokens survive to send-time interpolation.
async function builtInDefault(
  type: EditableEmailType,
  locale: string,
): Promise<EmailContent> {
  const config = EDITABLE_EMAIL_TEMPLATES[type];
  const loc = locale.length > 0 ? locale : DEFAULT_LOCALE;
  if (config.defaultIsHtml) {
    const def = htmlTemplateDefault(type, loc);
    return {
      subject: def.subject,
      bodyText: htmlToPlainText(def.bodyHtml),
      bodyHtml: def.bodyHtml,
    };
  }
  const t = await getTranslations({ locale: loc, namespace: config.i18nKey });
  const literalVars = Object.fromEntries(
    config.variables.map((v) => [v, `{${v}}`]),
  );
  return {
    subject: t("subject", literalVars),
    bodyText: t("textBody", literalVars),
    bodyHtml: null,
  };
}

// The active content for (fund, type, language): the assigned library
// template's localization for this language, else the built-in default. The
// assignment is fund-scoped (unique on fundId+type) and its templateId always
// belongs to the same fund (enforced on assign), so the localization lookup is
// safe. A template with no localization for this language falls back to the
// default for that language only.
export async function loadActiveTemplateContent(args: {
  fundId: string;
  type: EditableEmailType;
  locale: string;
}): Promise<EmailContent> {
  const assignment = await prisma.emailTemplateAssignment.findUnique({
    where: { fundId_type: { fundId: args.fundId, type: args.type } },
    select: { templateId: true },
  });
  if (assignment?.templateId) {
    const loc = await prisma.emailTemplateLocalization.findUnique({
      where: {
        templateId_locale: {
          templateId: assignment.templateId,
          locale: args.locale,
        },
      },
      select: { subject: true, bodyText: true, bodyHtml: true },
    });
    if (loc) return loc;
  }
  return builtInDefault(args.type, args.locale);
}

// Like loadActiveTemplateContent but for one explicit template (or the default
// when templateId is null) — used by the editor's test-send so an admin can
// test any template regardless of which one is active. Fund-scoped: the
// template must belong to the fund and match the type.
export async function loadTemplateContentById(args: {
  fundId: string;
  type: EditableEmailType;
  templateId: string | null;
  locale: string;
}): Promise<EmailContent> {
  if (args.templateId) {
    const tmpl = await prisma.emailTemplate.findFirst({
      where: { id: args.templateId, fundId: args.fundId, type: args.type },
      select: {
        localizations: {
          where: { locale: args.locale },
          select: { subject: true, bodyText: true, bodyHtml: true },
        },
      },
    });
    const loc = tmpl?.localizations[0];
    if (loc) return loc;
  }
  return builtInDefault(args.type, args.locale);
}

// Interpolate raw content into a sendable email. Text/subject use `vars`; the
// HTML body layers `htmlVars` on top (for "rich" tokens like {shopList} that
// have distinct HTML vs text expansions). No override authored (default is
// plain text) → bodyHtml null → html undefined, so the branded shell renders
// the plain-text body itself, exactly as before.
function renderContent(
  content: EmailContent,
  vars: Record<string, string>,
  htmlVars?: Record<string, string>,
): Rendered {
  return {
    subject: interpolate(content.subject, vars),
    text: interpolate(content.bodyText, vars),
    html: content.bodyHtml
      ? interpolate(content.bodyHtml, htmlVars ? { ...vars, ...htmlVars } : vars)
      : undefined,
  };
}

// Generic send-time resolver for any editable type whose variables are plain
// scalars (everything except ALLOCATION_CONFIRMATION's lazy {shopList}). Loads
// the fund's active template (or the built-in default) and interpolates.
export async function resolveEmailTemplate(args: {
  fundId: string;
  type: EditableEmailType;
  // Recipient's language (resolved by dispatchTemplate).
  locale: string;
  vars: Record<string, string>;
  // Extra/override tokens applied only to the HTML body.
  htmlVars?: Record<string, string>;
}): Promise<Rendered> {
  const content = await loadActiveTemplateContent({
    fundId: args.fundId,
    type: args.type,
    locale: args.locale,
  });
  return renderContent(content, args.vars, args.htmlVars);
}

// The ALLOCATION_CONFIRMATION email — the one type with "rich" variables. Loads
// the active template (or default), then resolves {cardSerial}/{shopList}
// lazily (only queried when the content actually references them) since the
// default never does.
export async function resolveAllocationTemplate(args: {
  fundId: string;
  account: string | null;
  locale: string;
  vars: {
    firstName: string;
    lastName: string;
    fundName: string;
    amount: string;
  };
}): Promise<Rendered> {
  const content = await loadActiveTemplateContent({
    fundId: args.fundId,
    type: "ALLOCATION_CONFIRMATION",
    locale: args.locale,
  });
  const scan = `${content.subject}\n${content.bodyText}\n${content.bodyHtml ?? ""}`;
  const cardSerial = scan.includes("{cardSerial}")
    ? await resolveCardSerial(args.account)
    : "";
  const shop = scan.includes("{shopList}")
    ? await buildShopList(args.fundId)
    : { html: "", text: "" };
  const base = { ...args.vars, cardSerial };
  return renderContent(
    content,
    { ...base, shopList: shop.text },
    { shopList: shop.html },
  );
}

// One editable template's content for one language, as HTML (the editor always
// works in HTML). `null` for a locale a custom template hasn't authored yet.
export type LibraryLocaleContent = { subject: string; bodyHtml: string };

export type LibraryTemplateView = {
  id: string;
  name: string;
  byLocale: Record<string, LibraryLocaleContent | null>;
};

export type EmailTemplateLibraryView = {
  type: EditableEmailType;
  variables: readonly string[];
  // The read-only built-in default for every language (HTML, {tokens} literal).
  defaultByLocale: Record<string, LibraryLocaleContent>;
  // The fund's custom templates for this type (oldest first).
  templates: LibraryTemplateView[];
  // Which template is active (null = the built-in default).
  activeTemplateId: string | null;
};

// The built-in default rendered as editor-ready HTML content for one language.
async function defaultAsEditorContent(
  type: EditableEmailType,
  locale: string,
): Promise<LibraryLocaleContent> {
  const config = EDITABLE_EMAIL_TEMPLATES[type];
  if (config.defaultIsHtml) {
    return htmlTemplateDefault(type, locale);
  }
  const t = await getTranslations({ locale, namespace: config.i18nKey });
  const literalVars = Object.fromEntries(
    config.variables.map((v) => [v, `{${v}}`]),
  );
  return {
    subject: t("subject", literalVars),
    bodyHtml: plainTextToHtml(t("textBody", literalVars)),
  };
}

// Everything the Templates editor needs for one email type: the read-only
// built-in default per language, the fund's custom templates (each per
// language, HTML), and which one is currently active. Fund-scoped.
export async function getEmailTemplateLibrary(args: {
  type: EditableEmailType;
  fundId: string;
}): Promise<EmailTemplateLibraryView> {
  const [templates, assignment, defaultEntries] = await Promise.all([
    prisma.emailTemplate.findMany({
      where: { fundId: args.fundId, type: args.type },
      select: {
        id: true,
        name: true,
        localizations: {
          select: { locale: true, subject: true, bodyText: true, bodyHtml: true },
        },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.emailTemplateAssignment.findUnique({
      where: { fundId_type: { fundId: args.fundId, type: args.type } },
      select: { templateId: true },
    }),
    Promise.all(
      SUPPORTED_LOCALES.map(
        async (locale) =>
          [locale, await defaultAsEditorContent(args.type, locale)] as const,
      ),
    ),
  ]);

  const templateViews: LibraryTemplateView[] = templates.map((tmpl) => ({
    id: tmpl.id,
    name: tmpl.name,
    byLocale: Object.fromEntries(
      SUPPORTED_LOCALES.map((locale) => {
        const l = tmpl.localizations.find((x) => x.locale === locale);
        return [
          locale,
          l
            ? {
                subject: l.subject,
                bodyHtml: l.bodyHtml ?? plainTextToHtml(l.bodyText),
              }
            : null,
        ];
      }),
    ),
  }));

  return {
    type: args.type,
    variables: EDITABLE_EMAIL_TEMPLATES[args.type].variables,
    defaultByLocale: Object.fromEntries(defaultEntries),
    templates: templateViews,
    activeTemplateId: assignment?.templateId ?? null,
  };
}
