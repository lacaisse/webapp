// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";

import { requireFundRole } from "@/services/auth/dal";
import { prisma } from "@/services/db/prisma";

import { dispatchCardAssignedEmail } from "./notify";

// Manual "your card is on its way" notification, driven from the card detail
// page. There's no automatic trigger — an admin sends it by hand once the card
// is assigned to a member, and the page surfaces whether it has already gone
// out (the linked Email row's status).
//
// One Email row per (card, member) — keyed so re-assigning a card to a
// different holder gets its own notification. This is a manual, confirm-gated
// admin action, so a repeat click is an explicit "send again": we reuse the
// existing row, re-queue it, and send afresh (no alreadySent short-circuit).

export type NotifyCardResult = { ok: true } | { error: string };

export async function notifyCardAssignedAction(input: {
  cardId: string;
}): Promise<NotifyCardResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("OPERATOR");

  const card = await prisma.card.findFirst({
    where: { id: input.cardId, fundId: fund.id },
    select: {
      id: true,
      serialNumber: true,
      number: true,
      memberId: true,
      member: {
        select: {
          email: true,
          firstName: true,
          lastName: true,
          address: true,
          postalCode: true,
          city: true,
        },
      },
    },
  });
  if (!card) return { error: t("cards.admin.notify.errors.notFound" as never) };
  if (!card.memberId || !card.member) {
    return { error: t("cards.admin.notify.errors.noMember" as never) };
  }
  if (!card.member.email) {
    return { error: t("cards.admin.notify.errors.noEmail" as never) };
  }

  let status: "SENT" | "FAILED";
  try {
    status = await dispatchCardAssignedEmail({
      fund,
      card: {
        ...card,
        memberId: card.memberId,
        member: { ...card.member, email: card.member.email },
      },
    });
  } catch (e) {
    console.error("[notify] failed to queue card-assigned email", card.id, e);
    return { error: t("cards.admin.notify.errors.sendFailed" as never) };
  }

  revalidatePath("/cards");
  revalidatePath(`/cards/${card.id}`);
  if (status === "SENT") return { ok: true };
  return { error: t("cards.admin.notify.errors.sendFailed" as never) };
}
