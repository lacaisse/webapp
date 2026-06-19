// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";

import { requireFundRole } from "@/services/auth/dal";
import { prisma } from "@/services/db/prisma";
import {
  DOCUMENT_PREVIEW_SAMPLE_VALUES,
  PreviewDocumentTemplateSchema,
  SaveDocumentTemplateSchema,
  findUnknownDocumentPlaceholders,
  interpolateDocument,
  type PreviewDocumentTemplateInput,
  type SaveDocumentTemplateInput,
} from "./config";
import { renderDocumentPdf } from "./pdf";

export type DocumentTemplateActionResult = { ok: true } | { error: string };

// Save (create or replace) a fund's override for an editable document template.
// Re-validates the shared schema and rejects any {{token}} outside the type's
// allowed set, so a stored letter never prints a broken placeholder.
// ADMIN-gated like the other fund settings.
export async function saveDocumentTemplateAction(
  input: SaveDocumentTemplateInput,
): Promise<DocumentTemplateActionResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const parsed = SaveDocumentTemplateSchema.safeParse(input);
  if (!parsed.success) {
    return { error: t(parsed.error.issues[0].message as never) };
  }
  const { type, body } = parsed.data;

  const unknown = findUnknownDocumentPlaceholders(type, body);
  if (unknown.length > 0) {
    return {
      error: t(
        "fund.settings.documentTemplates.errors.unknownVariable" as never,
        { name: unknown[0] } as never,
      ),
    };
  }

  await prisma.documentTemplate.upsert({
    where: { fundId_type: { fundId: fund.id, type } },
    create: { fundId: fund.id, type, body },
    update: { body },
  });

  revalidatePath("/settings");
  return { ok: true };
}

// Drop a fund's override so the built-in default takes over again.
export async function resetDocumentTemplateAction(input: {
  type: SaveDocumentTemplateInput["type"];
}): Promise<DocumentTemplateActionResult> {
  const { fund } = await requireFundRole("ADMIN");
  await prisma.documentTemplate.deleteMany({
    where: { fundId: fund.id, type: input.type },
  });
  revalidatePath("/settings");
  return { ok: true };
}

export type DocumentPreviewResult =
  | { ok: true; dataUrl: string }
  | { error: string };

// Render the editor's live preview: interpolate the draft body with sample
// values, render to PDF, and return a base64 data URL the editor embeds in an
// iframe. Never persists.
export async function previewDocumentTemplateAction(
  input: PreviewDocumentTemplateInput,
): Promise<DocumentPreviewResult> {
  const { fund } = await requireFundRole("ADMIN");
  const parsed = PreviewDocumentTemplateSchema.safeParse(input);
  if (!parsed.success) return { error: "invalid" };
  const { type, body } = parsed.data;

  const interpolated = interpolateDocument(body, {
    ...DOCUMENT_PREVIEW_SAMPLE_VALUES[type],
    fund_name: fund.name,
    full_name: fund.fullName?.trim() || fund.name,
    website: fund.websiteUrl ?? DOCUMENT_PREVIEW_SAMPLE_VALUES[type].website,
  });
  const pdf = await renderDocumentPdf(interpolated, {
    fundName: fund.name,
    fullName: fund.fullName,
    primaryColor: fund.primaryColor,
    logoUrl: fund.logoUrl,
  });
  const dataUrl = `data:application/pdf;base64,${pdf.toString("base64")}`;
  return { ok: true, dataUrl };
}
