// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";

import { requireFundRole } from "@/services/auth/dal";
import { prisma } from "@/services/db/prisma";
import { renderBrandedEmail } from "./template";
import {
  PREVIEW_SAMPLE_VALUES,
  PreviewEmailTemplateSchema,
  SaveEmailTemplateSchema,
  findUnknownPlaceholders,
  type PreviewEmailTemplateInput,
  type SaveEmailTemplateInput,
} from "./template-config";
import { buildShopList, htmlToPlainText, interpolate } from "./templates";

export type TemplateActionResult = { ok: true } | { error: string };

// Save (create or replace) a fund's override for an editable email template.
// Re-validates the shared schema and rejects any {token} not in the template's
// allowed variable set, so a stored template never renders a broken
// placeholder. The body is rich HTML; a plain-text version is derived for the
// text/plain MIME part. ADMIN-gated like the other fund settings.
export async function saveEmailTemplateAction(
  input: SaveEmailTemplateInput,
): Promise<TemplateActionResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const parsed = SaveEmailTemplateSchema.safeParse(input);
  if (!parsed.success) {
    return { error: t(parsed.error.issues[0].message as never) };
  }
  const { type, subject, bodyHtml } = parsed.data;

  const unknown = findUnknownPlaceholders(type, subject, bodyHtml);
  if (unknown.length > 0) {
    return {
      error: t("fund.settings.emailTemplates.errors.unknownVariable" as never, {
        name: unknown[0],
      } as never),
    };
  }

  const bodyText = htmlToPlainText(bodyHtml);
  await prisma.emailTemplate.upsert({
    where: { fundId_type: { fundId: fund.id, type } },
    create: { fundId: fund.id, type, subject, bodyHtml, bodyText },
    update: { subject, bodyHtml, bodyText },
  });

  revalidatePath("/settings");
  return { ok: true };
}

// Drop a fund's override so the built-in i18n default takes over again.
export async function resetEmailTemplateAction(input: {
  type: SaveEmailTemplateInput["type"];
}): Promise<TemplateActionResult> {
  const { fund } = await requireFundRole("ADMIN");
  await prisma.emailTemplate.deleteMany({
    where: { fundId: fund.id, type: input.type },
  });
  revalidatePath("/settings");
  return { ok: true };
}

export type PreviewResult = { ok: true; html: string } | { error: string };

// Render the live editor preview: interpolate the draft subject/body with
// sample values, wrap in the fund's branded shell, and return the full HTML
// document for the editor to show in a sandboxed iframe. Never persists.
export async function previewEmailTemplateAction(
  input: PreviewEmailTemplateInput,
): Promise<PreviewResult> {
  const { fund } = await requireFundRole("ADMIN");
  const parsed = PreviewEmailTemplateSchema.safeParse(input);
  if (!parsed.success) {
    return { error: "invalid" };
  }
  const { type, subject, bodyHtml } = parsed.data;

  // Preview shows the real active-merchant list so {shopList} looks accurate.
  const shop = await buildShopList(fund.id);
  const scalar = { ...PREVIEW_SAMPLE_VALUES[type], fundName: fund.name };
  const html = await renderBrandedEmail({
    fundName: fund.name,
    primaryColor: fund.primaryColor,
    logoUrl: fund.logoUrl,
    subject: interpolate(subject, { ...scalar, shopList: shop.text }),
    text: "",
    html: interpolate(bodyHtml, { ...scalar, shopList: shop.html }),
  });
  return { ok: true, html };
}
