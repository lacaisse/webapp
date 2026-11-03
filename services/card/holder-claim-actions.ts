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
import { scheduleMemberApiSync } from "@/services/member/api-sync";

import {
  bindCardToHolder,
  closePendingClaims,
  ensureFundCard,
  findFundCard,
  unbindCardFromHolder,
  writeHolderEvent,
} from "./holder-claims";
import { scheduleCardHolderNamePublish } from "./publish-holder-name";

// The fund's side of wallet claims (plan "Bread card-holder voting", PR W-2;
// the webhook side is ./holder-claims.ts). A claim the api could not prove
// waits for the fund: staff (OPERATOR+, card management) confirm it — the api
// attaches the card, and its `card.attached` webhook then finds the card
// already bound and changes nothing — or refuse it (the api drops it). An
// ADMIN can detach a card from a member's login from the card page: that
// makes the card public on the wallet again and takes its vote away, so it
// takes the same fresh re-authentication as the PIN unblock, gated after the
// role and card checks and before anything is written.
//
// Error codes resolve under `cards.admin.holderClaims.errors.*`.

export type HolderClaimActionResult = { ok: true } | { error: string };
export type DetachCardHolderResult = { ok: true } | { error: string } | ReauthRequiredError;

type ErrorCode =
  | "notFound"
  | "notPending"
  | "notMember"
  | "loginRemoved"
  | "notAttached"
  | "apiNotDeployed"
  | "apiRefused"
  | "failed";

async function errorResult(code: ErrorCode): Promise<{ error: string }> {
  const t = await getTranslations();
  return { error: t(`cards.admin.holderClaims.errors.${code}` as never) };
}

async function loadClaim(fundId: string, claimId: string) {
  return prisma.cardHolderClaim.findFirst({
    where: { id: claimId, fundId },
    select: {
      id: true,
      status: true,
      serial: true,
      holderRef: true,
      cardId: true,
      member: { select: { id: true, userId: true, emailVerifiedAt: true } },
    },
  });
}

function revalidateCard(cardId: string | null, memberId?: string | null): void {
  revalidatePath("/cards");
  if (cardId) revalidatePath(`/cards/${cardId}`);
  if (memberId) {
    revalidatePath("/members");
    revalidatePath(`/members/${memberId}`);
  }
}

export async function confirmCardHolderClaimAction(input: {
  claimId: string;
}): Promise<HolderClaimActionResult> {
  const { fund, user } = await requireFundRole("OPERATOR");

  const claim = await loadClaim(fund.id, input.claimId);
  if (!claim) return errorResult("notFound");
  if (claim.status !== "PENDING") return errorResult("notPending");
  if (!claim.member) return errorResult("notMember");
  // The login the claim names must still be that member's, verified: a
  // member who removed their login (or whose email was never confirmed)
  // cannot be given a private, voting card.
  if (claim.member.userId !== claim.holderRef || !claim.member.emailVerifiedAt) {
    return errorResult("loginRemoved");
  }
  const memberId = claim.member.id;

  // The api first: it holds the claim, and its answer is what makes the
  // attachment true. Its `card.attached {proof: "fund"}` webhook may land
  // before the local write below; the webhook then binds the card itself
  // (same member) and this action only records the decision.
  try {
    await getCitizenPayClient(fund).confirmCardHolder(claim.serial, claim.holderRef);
  } catch (e) {
    if (e instanceof CitizenPayApiError && e.status === 404) {
      console.warn("[card.holder-claims] confirm: route or card not found", claim.serial);
      return errorResult("apiNotDeployed");
    }
    if (e instanceof CitizenPayApiError && e.status === 409) {
      return errorResult("apiRefused");
    }
    console.error("[card.holder-claims] confirm failed", claim.serial, e);
    return errorResult("failed");
  }

  let cardId: string;
  try {
    const { card } = await ensureFundCard(fund, claim.serial);
    cardId = card.id;
    const event = {
      kind: "CLAIM_CONFIRMED" as const,
      source: "ADMIN" as const,
      actorUserId: user.id,
      detail: "fund",
    };
    let previousMemberId: string | null = null;
    if (card.memberId === memberId) {
      // The webhook won the race: the binding is there, record who decided.
      await writeHolderEvent(fund.id, card.id, event);
    } else {
      ({ previousMemberId } = await bindCardToHolder({
        fundId: fund.id,
        card,
        memberId,
        event,
      }));
    }
    await prisma.cardHolderClaim.update({
      where: { id: claim.id },
      data: {
        status: "CONFIRMED",
        decidedAt: new Date(),
        decidedById: user.id,
        cardId: card.id,
      },
    });
    scheduleMemberApiSync(previousMemberId ? [memberId, previousMemberId] : memberId);
  } catch (e) {
    // The api attached the card; its webhook binds it here if this did not.
    console.error("[card.holder-claims] confirm: local write failed", claim.serial, e);
    return errorResult("failed");
  }

  revalidateCard(cardId, memberId);
  return { ok: true };
}

export async function refuseCardHolderClaimAction(input: {
  claimId: string;
}): Promise<HolderClaimActionResult> {
  const { fund, user } = await requireFundRole("OPERATOR");

  const claim = await loadClaim(fund.id, input.claimId);
  if (!claim) return errorResult("notFound");
  if (claim.status !== "PENDING") return errorResult("notPending");

  // DELETE …/holder drops the claim at the api. A 404 = nothing there (or
  // the route is missing): the claim is refused here all the same.
  try {
    await getCitizenPayClient(fund).setCardHolder(claim.serial, null);
  } catch (e) {
    if (e instanceof CitizenPayApiError && e.status === 404) {
      console.warn("[card.holder-claims] refuse: nothing at the api", claim.serial);
    } else {
      console.error("[card.holder-claims] refuse failed", claim.serial, e);
      return errorResult("failed");
    }
  }

  try {
    // The api's `card.detached` may have superseded it meanwhile; the
    // fund's decision is still the record.
    await prisma.cardHolderClaim.updateMany({
      where: { id: claim.id, status: { in: ["PENDING", "SUPERSEDED"] } },
      data: { status: "REFUSED", decidedAt: new Date(), decidedById: user.id },
    });
    const card = claim.cardId
      ? { id: claim.cardId }
      : await findFundCard(fund.id, claim.serial);
    if (card) {
      await writeHolderEvent(fund.id, card.id, {
        kind: "CLAIM_REFUSED",
        source: "ADMIN",
        actorUserId: user.id,
      });
    }
    revalidateCard(card?.id ?? null);
  } catch (e) {
    console.error("[card.holder-claims] refuse: local write failed", claim.serial, e);
    return errorResult("failed");
  }
  return { ok: true };
}

export async function detachCardHolderAction(input: {
  cardId: string;
}): Promise<DetachCardHolderResult> {
  const t = await getTranslations();
  const { fund, user } = await requireFundRole("ADMIN");

  const card = await prisma.card.findFirst({
    where: { id: input.cardId, fundId: fund.id },
    select: {
      id: true,
      serialNumber: true,
      memberId: true,
      formerMemberId: true,
      member: { select: { id: true, userId: true } },
    },
  });
  if (!card) return errorResult("notFound");
  if (!card.memberId || !card.member?.userId) return errorResult("notAttached");

  if (!(await hasRecentAuth())) {
    return { error: t("auth.errors.reauthRequired" as never), code: REAUTH_REQUIRED };
  }

  // Local first, like the PIN unblock: the api posts `card.detached` the
  // moment it drops the holder, and that webhook then finds the card already
  // unbound and writes no second line. An api failure rolls it back.
  const memberId = card.memberId;
  const { primaryCleared, eventId } = await unbindCardFromHolder({
    fundId: fund.id,
    card: { id: card.id, memberId },
    event: { kind: "HOLDER_DETACHED", source: "ADMIN", actorUserId: user.id },
  });

  try {
    await getCitizenPayClient(fund).setCardHolder(card.serialNumber, null);
  } catch (e) {
    if (e instanceof CitizenPayApiError && e.status === 404) {
      // Nothing attached at the api, or its holder route is not deployed:
      // the local unbind stands (the holder sync would send the same DELETE).
      console.warn("[card.holder-claims] detach: nothing attached at the api", card.serialNumber);
    } else {
      try {
        await prisma.card.update({
          where: { id: card.id },
          data: { memberId, formerMemberId: card.formerMemberId },
        });
        if (primaryCleared) {
          await prisma.member.update({
            where: { id: memberId },
            data: { primaryCardId: card.id },
          });
        }
        if (eventId) await prisma.cardEvent.delete({ where: { id: eventId } });
      } catch (re) {
        console.error("[card.holder-claims] detach rollback failed", card.id, re);
      }
      console.error("[card.holder-claims] detach failed", card.serialNumber, e);
      return errorResult("failed");
    }
  }

  // Nothing is pending on a card the fund just detached.
  try {
    await closePendingClaims({ fundId: fund.id, serial: card.serialNumber, status: "SUPERSEDED" });
  } catch (e) {
    console.error("[card.holder-claims] detach: claim close failed", card.id, e);
  }

  // Back to CP's default wallet name, and the member's declared cards
  // without this one.
  scheduleCardHolderNamePublish(fund, card.id);
  scheduleMemberApiSync(memberId);

  revalidateCard(card.id, memberId);
  return { ok: true };
}
