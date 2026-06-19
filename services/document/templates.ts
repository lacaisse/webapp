// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { getLocale } from "next-intl/server";

import { prisma } from "@/services/db/prisma";
import { DEFAULT_LOCALE } from "@/services/i18n/config";
import {
  documentDefaultBody,
  interpolateDocument,
  type EditableDocumentType,
} from "./config";

// Resolve a document's body for rendering: the fund's saved override if present,
// otherwise the built-in default for the current request locale. {{tokens}} are
// interpolated from `vars` (caller-supplied scalars). Mirrors the email
// template resolver, but documents are plain markdown-ish text (no subject/HTML
// split — the PDF renderer owns layout).
export async function resolveDocumentTemplate(args: {
  fundId: string;
  type: EditableDocumentType;
  vars: Record<string, string>;
}): Promise<string> {
  const override = await prisma.documentTemplate.findUnique({
    where: { fundId_type: { fundId: args.fundId, type: args.type } },
    select: { body: true },
  });
  const body = override?.body ?? documentDefaultBody(args.type, await getLocale());
  return interpolateDocument(body, args.vars);
}

// For the settings editor: the saved override (if any) plus the built-in
// default, both with {{placeholders}} left literal so the admin sees which
// tokens are available. "Reset to default" drops the override. The locale is
// the fund's configured default (so the editor matches what members receive).
export async function getDocumentTemplateForEditing(args: {
  type: EditableDocumentType;
  fund: { id: string; defaultLocale: string };
}): Promise<{ override: string | null; base: string }> {
  const stored = await prisma.documentTemplate.findUnique({
    where: { fundId_type: { fundId: args.fund.id, type: args.type } },
    select: { body: true },
  });

  const locale =
    args.fund.defaultLocale && args.fund.defaultLocale.length > 0
      ? args.fund.defaultLocale
      : DEFAULT_LOCALE;

  return {
    override: stored?.body ?? null,
    base: documentDefaultBody(args.type, locale),
  };
}
