// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { getTranslations } from "next-intl/server";

import { prisma } from "@/services/db/prisma";
import { DEFAULT_LOCALE } from "@/services/i18n/config";
import { EDITABLE_EMAIL_TEMPLATES } from "./template-config";

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

// The fund's active merchants, formatted as a {shopList} value — an HTML <ul>
// for the HTML body and dashed lines for the text part. Empty when the fund
// has no active merchants yet.
export async function buildShopList(
  fundId: string,
): Promise<{ html: string; text: string }> {
  const merchants = await prisma.merchant.findMany({
    where: { fundId, status: "ACTIVE" },
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

// For the settings editor: the saved override (if any) plus the built-in
// default, both as HTML with {placeholders} left literal so the admin sees
// which tokens are available. "Reset to default" drops the override and falls
// back to the base.
export async function getAllocationTemplateForEditing(args: {
  fund: { id: string; defaultLocale: string };
}): Promise<{
  override: { subject: string; bodyHtml: string } | null;
  base: { subject: string; bodyHtml: string };
  variables: readonly string[];
}> {
  const config = EDITABLE_EMAIL_TEMPLATES.ALLOCATION_CONFIRMATION;

  const stored = await prisma.emailTemplate.findUnique({
    where: {
      fundId_type: { fundId: args.fund.id, type: "ALLOCATION_CONFIRMATION" },
    },
    select: { subject: true, bodyText: true, bodyHtml: true },
  });

  // Render the i18n default in the fund's locale, feeding each variable its own
  // brace token back as the value so the default keeps literal {placeholders}.
  const locale =
    args.fund.defaultLocale && args.fund.defaultLocale.length > 0
      ? args.fund.defaultLocale
      : DEFAULT_LOCALE;
  const t = await getTranslations({ locale, namespace: config.i18nKey });
  const literalVars = Object.fromEntries(
    config.variables.map((v) => [v, `{${v}}`]),
  );
  const base = {
    subject: t("subject", literalVars),
    bodyHtml: plainTextToHtml(t("textBody", literalVars)),
  };

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
