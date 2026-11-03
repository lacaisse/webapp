// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";

import { requireFundRole } from "@/services/auth/dal";
import { hasRecentAuth } from "@/services/auth/step-up";
import {
  REAUTH_REQUIRED,
  type ReauthRequiredError,
} from "@/services/auth/step-up-types";
import { CitizenPayApiError } from "@/services/citizenpay/api";
import { getCitizenPayClient } from "@/services/citizenpay/client";
import { prisma } from "@/services/db/prisma";

import { isPinBlocked } from "./pin-block-rules";

// The fund's explicit unblock of a PIN-blocked card (D12): `PATCH
// {status:"active", unblock:true}` on the api, which also resets the
// wrong-entry counter. Lifting a block that three wrong PIN entries caused
// lets whoever holds the card try again, so it takes an ADMIN with a fresh
// re-authentication (the step-up of services/auth/step-up.ts, gated after
// the role and card checks and before anything is written, like the manual
// mint/burn) and is written to the card's audit trail with the acting user.
// The plain status dialog (setCardStatusAction) refuses PIN-blocked cards
// and points here.

export type UnblockCardPinResult =
  | { ok: true }
  | { error: string }
  | ReauthRequiredError;

export async function unblockCardPinAction(input: {
  cardId: string;
}): Promise<UnblockCardPinResult> {
  const t = await getTranslations();
  const { fund, user } = await requireFundRole("ADMIN");

  const card = await prisma.card.findFirst({
    where: { id: input.cardId, fundId: fund.id },
    select: {
      id: true,
      serialNumber: true,
      status: true,
      blockedReason: true,
      memberId: true,
    },
  });
  if (!card) return { error: t("cards.admin.errors.notFound" as never) };
  if (!isPinBlocked(card)) {
    return { error: t("cards.admin.pinBlock.errors.notPinBlocked" as never) };
  }

  if (!(await hasRecentAuth())) {
    return { error: t("auth.errors.reauthRequired" as never), code: REAUTH_REQUIRED };
  }

  try {
    await getCitizenPayClient(fund).unblockCardPin(card.serialNumber);
  } catch (e) {
    if (e instanceof CitizenPayApiError && e.status === 409) {
      // An enrolled fund cannot lift the issuer's block.
      return { error: t("cards.admin.pinBlock.errors.apiRefused" as never) };
    }
    console.error("[card.pin-block] unblock failed", card.id, e);
    return { error: t("cards.admin.pinBlock.errors.failed" as never) };
  }

  await prisma.card.update({
    where: { id: card.id },
    data: { status: "ACTIVE", blockedReason: null, blockedAt: null },
  });
  try {
    await prisma.cardEvent.create({
      data: {
        fundId: fund.id,
        cardId: card.id,
        kind: "PIN_UNBLOCKED",
        source: "ADMIN",
        actorUserId: user.id,
      },
    });
  } catch (e) {
    console.error("[card.pin-block] CardEvent write failed", card.id, e);
  }

  revalidatePath("/cards");
  revalidatePath(`/cards/${card.id}`);
  if (card.memberId) revalidatePath(`/members/${card.memberId}`);
  return { ok: true };
}
