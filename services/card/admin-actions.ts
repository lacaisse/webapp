// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";

import { requireFundRole } from "@/services/auth/dal";
import { getCitizenPayClient } from "@/services/citizenpay/client";
import { prisma } from "@/services/db/prisma";

// Card lifecycle is two independent dimensions:
//   - `status` (ACTIVE / INACTIVE / BLOCKED) drives whether CitizenPay's
//     terminal accepts the card. Source of truth on CP; we mirror it.
//   - `reportedLostAt` is internal-only. The fund records that the holder
//     said they lost the card. Doesn't affect terminal behaviour, but most
//     lost reports also trigger a block — the block dialog can do both in
//     one action.
//
// Both actions are scoped to the current fund — admin can only manage cards
// that belong to a member of their fund.

export type BlockCardResult = { ok: true } | { error: string };

export async function blockCardAction(input: {
  cardId: string;
  reportedLost?: boolean;
}): Promise<BlockCardResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const card = await prisma.card.findFirst({
    where: { id: input.cardId, member: { fundId: fund.id } },
    select: { id: true, serialNumber: true, status: true },
  });
  if (!card) return { error: t("cards.admin.errors.notFound" as never) };
  if (card.status === "BLOCKED") {
    return { error: t("cards.admin.errors.alreadyBlocked" as never) };
  }

  const now = new Date();
  await prisma.card.update({
    where: { id: card.id },
    data: {
      status: "BLOCKED",
      blockedAt: now,
      ...(input.reportedLost ? { reportedLostAt: now } : {}),
    },
  });

  // Push the block to CitizenPay. Local state is authoritative for the
  // admin UI; CP failure is logged and a future sync reconciles.
  try {
    await getCitizenPayClient().blockCard(card.serialNumber);
  } catch (e) {
    console.error("[citizenpay] blockCard failed", e);
  }

  revalidatePath("/cards");
  revalidatePath("/members");
  return { ok: true };
}

export async function unblockCardAction(input: {
  cardId: string;
  clearLostFlag?: boolean;
}): Promise<BlockCardResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const card = await prisma.card.findFirst({
    where: { id: input.cardId, member: { fundId: fund.id } },
    select: { id: true, serialNumber: true, status: true, reportedLostAt: true },
  });
  if (!card) return { error: t("cards.admin.errors.notFound" as never) };
  if (card.status === "ACTIVE") {
    return { error: t("cards.admin.errors.alreadyActive" as never) };
  }

  await prisma.card.update({
    where: { id: card.id },
    data: {
      status: "ACTIVE",
      blockedAt: null,
      ...(input.clearLostFlag ? { reportedLostAt: null } : {}),
    },
  });

  try {
    await getCitizenPayClient().unblockCard(card.serialNumber);
  } catch (e) {
    console.error("[citizenpay] unblockCard failed", e);
  }

  revalidatePath("/cards");
  revalidatePath("/members");
  return { ok: true };
}
