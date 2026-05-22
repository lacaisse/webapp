// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";
import { parseUnits } from "viem";
import { z } from "zod";

import { requireFundRole } from "@/services/auth/dal";
import { getCitizenPayClient } from "@/services/citizenpay/client";
import type { CardStatus } from "@/services/db/generated/enums";
import { prisma } from "@/services/db/prisma";
import {
  burnFromToken,
  mintToken,
  UserOpError,
  type FundMinterContext,
} from "@/services/token/userop";

import { computeCardSyncPlan } from "./sync";

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
    where: { id: input.cardId, fundId: fund.id },
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
    await getCitizenPayClient(fund).blockCard(card.serialNumber);
  } catch (e) {
    console.error("[citizenpay] blockCard failed", e);
  }

  revalidatePath("/cards");
  revalidatePath(`/cards/${card.id}`);
  revalidatePath("/members");
  return { ok: true };
}

// =============================================================================
// Top-up / withdraw
// =============================================================================
// Top-up = mint to the card's account; withdraw = burnFrom the card's
// account. Both go through the CP bundler / paymaster via services/token/userop
// (same path as /token's manual mint/burn) — the treasury Safe holds
// MINTER_ROLE / BURNER_ROLE directly, so we don't need CP's REST top-up /
// withdraw endpoints. We still write a TokenOperation row (MINT / BURN)
// keyed to the card + member so the audit log explains *why* the transfer
// happened — Alchemy can show the on-chain effect but can't link it back
// to business intent.

const CardOpSchema = z.object({
  cardId: z.string().min(1),
  amount: z
    .string()
    .regex(/^\d+(\.\d{1,2})?$/, { error: "cards.admin.errors.amountInvalid" })
    .refine((v) => Number(v) > 0, {
      error: "cards.admin.errors.amountPositive",
    }),
});

export type CardOpResult =
  | { ok: true; txHash: string }
  | { error: string; field?: "amount" };

export async function topUpCardAction(input: {
  cardId: string;
  amount: string;
}): Promise<CardOpResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const parsed = CardOpSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      error: t(issue.message as never),
      field: issue.path[0] === "amount" ? "amount" : undefined,
    };
  }

  const card = await prisma.card.findFirst({
    where: { id: parsed.data.cardId, fundId: fund.id },
    select: {
      id: true,
      account: true,
      memberId: true,
      member: { select: { tierId: true } },
    },
  });
  if (!card) return { error: t("cards.admin.errors.notFound" as never) };
  if (!card.account) {
    return { error: t("cards.admin.errors.noAccount" as never) };
  }
  if (!fund.tokenAddress || fund.tokenDecimals == null) {
    return { error: t("cards.admin.errors.tokenNotConfigured" as never) };
  }

  let amountUnits: bigint;
  try {
    amountUnits = parseUnits(parsed.data.amount, fund.tokenDecimals);
  } catch {
    return {
      error: t("cards.admin.errors.amountInvalid" as never),
      field: "amount",
    };
  }

  const op = await prisma.tokenOperation.create({
    data: {
      fundId: fund.id,
      type: "MINT",
      memberId: card.memberId,
      account: card.account,
      amount: parsed.data.amount,
      tierId: card.member?.tierId ?? null,
      status: "PENDING",
    },
  });

  try {
    const { txHash } = await mintToken({
      fund: fund as FundMinterContext,
      to: card.account as `0x${string}`,
      amount: amountUnits,
    });
    await prisma.tokenOperation.update({
      where: { id: op.id },
      data: { status: "CONFIRMED", txHash, confirmedAt: new Date() },
    });
    revalidatePath("/cards");
    revalidatePath(`/cards/${card.id}`);
    if (card.memberId) revalidatePath(`/members/${card.memberId}`);
    revalidatePath("/token");
    return { ok: true, txHash };
  } catch (e) {
    const errorMessage =
      e instanceof UserOpError ? `${e.code}: ${e.message}` : String(e);
    await prisma.tokenOperation.update({
      where: { id: op.id },
      data: { status: "FAILED", errorMessage },
    });
    console.error("[card] topUpCard failed", op.id, e);
    return { error: t("cards.admin.errors.submitFailed" as never) };
  }
}

export async function withdrawFromCardAction(input: {
  cardId: string;
  amount: string;
}): Promise<CardOpResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const parsed = CardOpSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      error: t(issue.message as never),
      field: issue.path[0] === "amount" ? "amount" : undefined,
    };
  }

  const card = await prisma.card.findFirst({
    where: { id: parsed.data.cardId, fundId: fund.id },
    select: {
      id: true,
      account: true,
      memberId: true,
      member: { select: { tierId: true } },
    },
  });
  if (!card) return { error: t("cards.admin.errors.notFound" as never) };
  if (!card.account) {
    return { error: t("cards.admin.errors.noAccount" as never) };
  }
  if (!fund.tokenAddress || fund.tokenDecimals == null) {
    return { error: t("cards.admin.errors.tokenNotConfigured" as never) };
  }

  let amountUnits: bigint;
  try {
    amountUnits = parseUnits(parsed.data.amount, fund.tokenDecimals);
  } catch {
    return {
      error: t("cards.admin.errors.amountInvalid" as never),
      field: "amount",
    };
  }

  const op = await prisma.tokenOperation.create({
    data: {
      fundId: fund.id,
      type: "BURN",
      memberId: card.memberId,
      account: card.account,
      amount: parsed.data.amount,
      tierId: card.member?.tierId ?? null,
      status: "PENDING",
    },
  });

  try {
    const { txHash } = await burnFromToken({
      fund: fund as FundMinterContext,
      from: card.account as `0x${string}`,
      amount: amountUnits,
    });
    await prisma.tokenOperation.update({
      where: { id: op.id },
      data: { status: "CONFIRMED", txHash, confirmedAt: new Date() },
    });
    revalidatePath("/cards");
    revalidatePath(`/cards/${card.id}`);
    if (card.memberId) revalidatePath(`/members/${card.memberId}`);
    revalidatePath("/token");
    return { ok: true, txHash };
  } catch (e) {
    const errorMessage =
      e instanceof UserOpError ? `${e.code}: ${e.message}` : String(e);
    await prisma.tokenOperation.update({
      where: { id: op.id },
      data: { status: "FAILED", errorMessage },
    });
    console.error("[card] withdrawFromCard failed", op.id, e);
    return { error: t("cards.admin.errors.submitFailed" as never) };
  }
}

export async function unblockCardAction(input: {
  cardId: string;
  clearLostFlag?: boolean;
}): Promise<BlockCardResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const card = await prisma.card.findFirst({
    where: { id: input.cardId, fundId: fund.id },
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
    await getCitizenPayClient(fund).unblockCard(card.serialNumber);
  } catch (e) {
    console.error("[citizenpay] unblockCard failed", e);
  }

  revalidatePath("/cards");
  revalidatePath(`/cards/${card.id}`);
  revalidatePath("/members");
  return { ok: true };
}

// =============================================================================
// Full sync — driven from the client for progress UX
// =============================================================================
// The Sync dialog on /cards calls `previewCardSyncAction` once to fetch
// the full plan (item lists, not just counts), then iterates the client
// side, calling one per-item action per card so it can render real-time
// "X of Y" progress per step. Steps run in this order:
//
//   1. importOne   — pull CP-only cards into local
//   2. pushStatus  — push local status to CP for mismatches
//   3. pushOne     — push local-only cards to CP
//
// Per-item actions never throw — they return { ok | error } so the
// dialog can keep running and surface a count of failures at the end.
// Local is authoritative; we never delete on either side from the sync
// flow (delete-from-CP exists separately when needed).

export type CardSyncPlanWire = {
  // Items the client iterates. Each entry has just what the per-item
  // action needs (serial for import, cardId for the others).
  import: Array<{ serialNumber: string }>;
  statusUpdate: Array<{ cardId: string; serialNumber: string }>;
  push: Array<{ cardId: string; serialNumber: string }>;
};

export type CardSyncPreviewResult =
  | { ok: true; plan: CardSyncPlanWire }
  | { error: string };

export async function previewCardSyncAction(): Promise<CardSyncPreviewResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  try {
    const plan = await computeCardSyncPlan(fund);
    return {
      ok: true,
      plan: {
        import: plan.import.map((i) => ({ serialNumber: i.serialNumber })),
        statusUpdate: plan.statusUpdate.map((i) => ({
          cardId: i.cardId,
          serialNumber: i.serialNumber,
        })),
        push: plan.push.map((i) => ({
          cardId: i.cardId,
          serialNumber: i.serialNumber,
        })),
      },
    };
  } catch (e) {
    console.error("[card.sync] preview failed", e);
    return { error: t("cards.admin.sync.errors.previewFailed" as never) };
  }
}

export type CardSyncItemResult = { ok: true } | { error: string };

export async function importOneCardAction(input: {
  serialNumber: string;
}): Promise<CardSyncItemResult> {
  const { fund } = await requireFundRole("ADMIN");

  // Already-exists is fine — concurrent sync runs, or a manual addCard
  // that landed between preview and execute. Treat as success.
  const existing = await prisma.card.findUnique({
    where: { serialNumber: input.serialNumber },
    select: { id: true },
  });
  if (existing) return { ok: true };

  let detail;
  try {
    detail = await getCitizenPayClient(fund).getCitizenPayCard(
      input.serialNumber,
    );
  } catch (e) {
    console.error("[card.sync] import getCard failed", input.serialNumber, e);
    return { error: input.serialNumber };
  }
  if (!detail) return { ok: true }; // CP raced us — nothing to do.

  try {
    await prisma.card.create({
      data: {
        fundId: fund.id,
        memberId: null,
        serialNumber: detail.serialNumber,
        account: detail.account,
        holderName: null,
        status: detail.status,
        issuedAt: new Date(detail.createdAt),
      },
    });
    return { ok: true };
  } catch (e) {
    console.error("[card.sync] import create failed", input.serialNumber, e);
    return { error: input.serialNumber };
  }
}

export async function pushOneCardStatusAction(input: {
  cardId: string;
}): Promise<CardSyncItemResult> {
  const { fund } = await requireFundRole("ADMIN");

  const card = await prisma.card.findFirst({
    where: { id: input.cardId, fundId: fund.id },
    select: { serialNumber: true, status: true },
  });
  if (!card) return { error: input.cardId };

  try {
    await getCitizenPayClient(fund).setCardStatus(
      card.serialNumber,
      card.status,
    );
    return { ok: true };
  } catch (e) {
    console.error("[card.sync] pushStatus failed", card.serialNumber, e);
    return { error: card.serialNumber };
  }
}

export async function pushOneCardAction(input: {
  cardId: string;
}): Promise<CardSyncItemResult> {
  const { fund } = await requireFundRole("ADMIN");

  const card = await prisma.card.findFirst({
    where: { id: input.cardId, fundId: fund.id },
    select: {
      id: true,
      serialNumber: true,
      account: true,
      holderName: true,
      member: { select: { firstName: true, lastName: true } },
    },
  });
  if (!card) return { error: input.cardId };

  try {
    const registered = await getCitizenPayClient(fund).registerCard({
      serialNumber: card.serialNumber,
      fundId: fund.id,
      fundCitizenPayId: fund.citizenPayFundId,
      holderName:
        card.holderName ||
        (card.member
          ? `${card.member.firstName} ${card.member.lastName}`.trim()
          : undefined),
    });
    if (registered.account && !card.account) {
      try {
        await prisma.card.update({
          where: { id: card.id },
          data: { account: registered.account },
        });
      } catch (e) {
        // account @unique collision — surface as a soft warning by way of
        // the run errors list; the CP side succeeded so don't fail hard.
        console.error("[card.sync] account backfill collision", card, e);
      }
    }
    return { ok: true };
  } catch (e) {
    console.error("[card.sync] push failed", card.serialNumber, e);
    return { error: card.serialNumber };
  }
}

/**
 * Called by the dialog once the whole sync run is done — flushes Next's
 * route cache so the cards list reflects the new rows. Doing this once
 * at the end (not after every per-item action) keeps the run quick.
 */
export async function revalidateCardsAfterSyncAction(): Promise<void> {
  await requireFundRole("ADMIN");
  revalidatePath("/cards");
}

export type UnattachedCardHit = {
  id: string;
  serialNumber: string;
  account: string | null;
  holderName: string | null;
  status: CardStatus;
};

// Typeahead backing the activate-member dialog. Returns unattached cards
// (memberId is null) in the current fund matching the serial query —
// admin picks one to link instead of free-typing a serial. With an empty
// query we surface the most-recently-imported cards so the operator has
// something to scroll if they don't have the printed serial in hand.
const UNATTACHED_LIMIT = 12;

export async function searchUnattachedCardsAction(
  q: string,
): Promise<UnattachedCardHit[]> {
  const { fund } = await requireFundRole("ADMIN");
  const term = q.trim();
  const where = {
    fundId: fund.id,
    memberId: null,
    ...(term.length > 0
      ? {
          serialNumber: { contains: term, mode: "insensitive" as const },
        }
      : {}),
  };
  const cards = await prisma.card.findMany({
    where,
    select: {
      id: true,
      serialNumber: true,
      account: true,
      holderName: true,
      status: true,
    },
    orderBy: { createdAt: "desc" },
    take: UNATTACHED_LIMIT,
  });
  return cards;
}
