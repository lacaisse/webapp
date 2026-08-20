// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";

import { requireFundRole } from "@/services/auth/dal";
import { prisma } from "@/services/db/prisma";
import {
  AccountEmbedSchema,
  EmbedDomainsSchema,
  RotateAccountEmbedSchema,
  generateEmbedSlug,
  parseEmbedDomains,
} from "./schema";

// Admin controls for the embeds settings tab. ADMIN+ throughout: the domain
// allowlist decides who may frame the fund's widgets, and an embed slug is a
// public bearer handle to an account's balance — neither is card/member
// management, so OPERATOR is deliberately excluded (see AGENTS.md roles).

export type EmbedActionResult = { ok: true } | { error: string };

/**
 * Replace the fund's allowlist of embedding domains. Stored normalised
 * (scheme/path stripped, lowercased, de-duplicated) because proxy.ts joins
 * these values straight into a `frame-ancestors` directive — the validation in
 * services/embed/schema.ts is what makes that safe, so it runs here on the
 * server regardless of what the client already checked.
 *
 * An empty list is a legitimate state, not an error: it means `'none'`, i.e.
 * the widgets stop rendering anywhere. The form warns about that in the UI.
 */
export async function updateEmbedDomainsAction(input: {
  domains: string;
}): Promise<EmbedActionResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const parsed = EmbedDomainsSchema.safeParse(input);
  if (!parsed.success) {
    return { error: t(parsed.error.issues[0].message as never) };
  }

  await prisma.fund.update({
    where: { id: fund.id },
    data: { embedAllowedDomains: parseEmbedDomains(parsed.data.domains) },
  });

  revalidatePath("/settings");
  return { ok: true };
}

/**
 * Turn the public account widget on or off for one account. Enabling mints a
 * fresh slug; disabling clears it, which immediately 404s every URL already
 * embedded on a website (hence the confirmation step in the UI).
 */
export async function setAccountEmbedAction(input: {
  accountId: string;
  enabled: boolean;
}): Promise<EmbedActionResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const parsed = AccountEmbedSchema.safeParse(input);
  if (!parsed.success) {
    return { error: t("fund.settings.embeds.accounts.errors.invalid") };
  }

  // An account id from the client is not proof of ownership — scope the write
  // to this fund so a pasted id from another fund can't be toggled.
  const updated = await prisma.fundTokenAccount.updateMany({
    where: { id: parsed.data.accountId, fundId: fund.id, archivedAt: null },
    data: { embedSlug: parsed.data.enabled ? generateEmbedSlug() : null },
  });
  if (updated.count === 0) {
    return { error: t("fund.settings.embeds.accounts.errors.notFound") };
  }

  revalidatePath("/settings");
  return { ok: true };
}

/**
 * Mint a new slug for an account that already has one. This is the revocation
 * path: the previously published URL stops resolving the moment this lands.
 */
export async function rotateAccountEmbedSlugAction(input: {
  accountId: string;
}): Promise<EmbedActionResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const parsed = RotateAccountEmbedSchema.safeParse(input);
  if (!parsed.success) {
    return { error: t("fund.settings.embeds.accounts.errors.invalid") };
  }

  // Fund-scoped, and only for an account that is currently embeddable —
  // rotating a disabled account would silently re-enable the widget.
  const updated = await prisma.fundTokenAccount.updateMany({
    where: {
      id: parsed.data.accountId,
      fundId: fund.id,
      archivedAt: null,
      embedSlug: { not: null },
    },
    data: { embedSlug: generateEmbedSlug() },
  });
  if (updated.count === 0) {
    return { error: t("fund.settings.embeds.accounts.errors.notFound") };
  }

  revalidatePath("/settings");
  return { ok: true };
}
