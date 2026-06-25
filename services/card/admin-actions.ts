// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";
import { parseUnits } from "viem";
import { z } from "zod";

import { ensureOpenPeriod } from "@/services/allocation-periods/ensure";
import { requireFundRole } from "@/services/auth/dal";
import { getCitizenPayClient } from "@/services/citizenpay/client";
import { Prisma } from "@/services/db/generated/client";
import type { AllocationMode, CardStatus } from "@/services/db/generated/enums";
import { prisma } from "@/services/db/prisma";
import { nextCardNumber } from "@/services/card/numbering";
import { normalizeSerial } from "@/services/card/serial";
import { parseCsv } from "@/services/csv/parse";
import { ANNOTATION_TRIGGERS } from "@/services/transaction-annotation/annotate";
import { resolveOrEnqueueAnnotation } from "@/services/transaction-annotation/pending";
import {
  burnFromToken,
  mintToken,
  UserOpError,
  type FundMinterContext,
} from "@/services/token/userop";

import { computeCardSyncPlan } from "./sync";

// Card lifecycle is two independent dimensions:
//   - `status` (ACTIVE / INACTIVE / BLOCKED): only BLOCKED makes CitizenPay's
//     terminal refuse the card. INACTIVE is the factory default (not charged
//     yet) and does NOT block — a card flips to ACTIVE automatically on its
//     first charge. Source of truth on CP; we mirror it.
//   - `reportedLostAt` is internal-only. The fund records that the holder
//     said they lost the card. Doesn't affect terminal behaviour, but most
//     lost reports also trigger a block — `setCardStatusAction` sets both in
//     one call.
//
// The status action is scoped to the current fund — admin can only manage
// cards that belong to a member of their fund.

export type BlockCardResult = { ok: true } | { error: string };

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
  // Optional incoming bank transfer to record this recharge against — so the
  // allocation is tied to a real deposit instead of looking manual (issue #28).
  bankTransactionId?: string | null;
}): Promise<CardOpResult> {
  const t = await getTranslations();
  const { fund, user } = await requireFundRole("ADMIN");

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

  // Validate the optional bank transfer up front (before minting) so a bad
  // pick fails cleanly. It must be an unmatched incoming deposit on this fund,
  // and the card must belong to a member (the deposit is attributed to them).
  const bankTransactionId = input.bankTransactionId?.trim() || null;
  if (bankTransactionId) {
    if (!card.memberId) {
      return { error: t("cards.admin.errors.bankTxNeedsMember" as never) };
    }
    const tx = await prisma.bankTransaction.findFirst({
      where: { id: bankTransactionId, fundId: fund.id },
      select: { id: true, direction: true, matchedAt: true },
    });
    if (!tx) return { error: t("cards.admin.errors.bankTxNotFound" as never) };
    if (tx.direction !== "INCOMING") {
      return { error: t("cards.admin.errors.bankTxNotIncoming" as never) };
    }
    if (tx.matchedAt) {
      return { error: t("cards.admin.errors.bankTxAlreadyMatched" as never) };
    }
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
    const { txHash, userOpHash } = await mintToken({
      fund: fund as FundMinterContext,
      to: card.account as `0x${string}`,
      amount: amountUnits,
    });
    await prisma.tokenOperation.update({
      where: { id: op.id },
      data: { status: "CONFIRMED", txHash, confirmedAt: new Date() },
    });
    // Attach the deposit: link it to the member + card (MANUAL), source-link
    // it to this mint so it reads as a real bank-transfer allocation, and learn
    // the IBAN for future auto-matching. The mint already landed, so a link
    // failure is logged, not surfaced — the recharge itself succeeded.
    if (bankTransactionId && card.memberId) {
      try {
        await linkTopUpDeposit({
          fund,
          bankTransactionId,
          memberId: card.memberId,
          cardId: card.id,
          tokenOperationId: op.id,
        });
      } catch (e) {
        console.error("[card] topUp bank-transfer link failed", op.id, e);
      }
    }
    await resolveOrEnqueueAnnotation({
      fundId: fund.id,
      chainId: fund.tokenChainId,
      userOpHash,
      kind: ANNOTATION_TRIGGERS.cardTopUp,
      trigger: ANNOTATION_TRIGGERS.cardTopUp,
      triggeredByUserId: user.id,
    });
    revalidatePath("/cards");
    revalidatePath(`/cards/${card.id}`);
    if (card.memberId) revalidatePath(`/members/${card.memberId}`);
    revalidatePath("/token");
    if (bankTransactionId) {
      revalidatePath("/allocations");
      revalidatePath("/bank");
    }
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
  const { fund, user } = await requireFundRole("ADMIN");

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
    const { txHash, userOpHash } = await burnFromToken({
      fund: fund as FundMinterContext,
      from: card.account as `0x${string}`,
      amount: amountUnits,
    });
    await prisma.tokenOperation.update({
      where: { id: op.id },
      data: { status: "CONFIRMED", txHash, confirmedAt: new Date() },
    });
    await resolveOrEnqueueAnnotation({
      fundId: fund.id,
      chainId: fund.tokenChainId,
      userOpHash,
      kind: ANNOTATION_TRIGGERS.cardWithdrawal,
      trigger: ANNOTATION_TRIGGERS.cardWithdrawal,
      triggeredByUserId: user.id,
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

// Tie a confirmed recharge to the incoming deposit that paid for it: match the
// deposit to the member + card (MANUAL), source-link it to the mint so it
// surfaces in allocation history like a bank-driven allocation, and learn the
// IBAN so the same account auto-matches next time. Mirrors the bank-sync
// attribution path (services/bank-sync). Not exported — only topUpCardAction
// calls it, after the mint has confirmed.
async function linkTopUpDeposit(args: {
  fund: {
    id: string;
    allocationMode: AllocationMode;
    allocationCutoffDay: number;
  };
  bankTransactionId: string;
  memberId: string;
  cardId: string;
  tokenOperationId: string;
}): Promise<void> {
  const tx = await prisma.bankTransaction.findFirst({
    where: { id: args.bankTransactionId, fundId: args.fund.id },
    select: { id: true, counterpartIban: true, allocationPeriodId: true },
  });
  if (!tx) return;

  // FIXED_PERIOD: tag the deposit to the open period so it shows there.
  let allocationPeriodId = tx.allocationPeriodId;
  if (args.fund.allocationMode === "FIXED_PERIOD" && !allocationPeriodId) {
    allocationPeriodId = await ensureOpenPeriod(
      args.fund.id,
      args.fund.allocationCutoffDay,
    );
  }

  await prisma.$transaction(async (db) => {
    await db.bankTransaction.update({
      where: { id: tx.id },
      data: {
        memberId: args.memberId,
        cardId: args.cardId,
        matchedAt: new Date(),
        matchMethod: "MANUAL",
        ...(allocationPeriodId ? { allocationPeriodId } : {}),
      },
    });
    await db.tokenOperationSource.create({
      data: {
        bankTransactionId: tx.id,
        tokenOperationId: args.tokenOperationId,
      },
    });
    if (tx.counterpartIban) {
      await db.linkedBankAccount.upsert({
        where: {
          fundId_iban: { fundId: args.fund.id, iban: tx.counterpartIban },
        },
        create: {
          fundId: args.fund.id,
          iban: tx.counterpartIban,
          memberId: args.memberId,
          source: "MANUAL",
        },
        update: { memberId: args.memberId },
      });
    }
  });
}

// Unmatched incoming deposits the operator can attach to a recharge. Read from
// our local mirror (populated by the bank-sync cron / full-sync), newest first.
export type PickableBankTransaction = {
  id: string;
  occurredAt: string; // ISO 8601
  amount: string; // unsigned magnitude, 2dp
  currency: string;
  counterpartName: string | null;
  reference: string | null;
};

export type ListUnmatchedDepositsResult =
  | { error: string }
  | {
      ok: true;
      transactions: PickableBankTransaction[];
      nextCursor: string | null;
    };

const DEPOSIT_PAGE_SIZE = 20;

// Strip combining diacritics so a search for "François" also matches the
// un-accented "FRANCOIS" that bank (SEPA) feeds emit. Case is handled by
// Prisma's `mode: "insensitive"`.
function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

// Search + keyset-paginate the fund's UNMATCHED incoming deposits (the review
// queue) for the recharge attach picker. `cursor` is the last row's id from the
// previous page; pass it back for the next page (newest-first). `search`
// matches counterpart name / reference / remittance / IBAN case-insensitively,
// and the exact amount when it parses as a number.
export async function listUnmatchedIncomingBankTransactionsAction(input?: {
  search?: string;
  cursor?: string;
}): Promise<ListUnmatchedDepositsResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const search = input?.search?.trim() ?? "";
  const cursor = input?.cursor?.trim() || null;

  try {
    const where: Prisma.BankTransactionWhereInput = {
      fundId: fund.id,
      direction: "INCOMING",
      matchedAt: null,
    };
    if (search) {
      const terms = [...new Set([search, stripAccents(search)])];
      const or: Prisma.BankTransactionWhereInput[] = terms.flatMap((term) => {
        const insensitive = { contains: term, mode: "insensitive" as const };
        return [
          { counterpartName: insensitive },
          { counterpartReference: insensitive },
          { remittanceInfo: insensitive },
          { counterpartIban: insensitive },
        ];
      });
      const amount = Number(search.replace(",", "."));
      if (Number.isFinite(amount)) or.push({ amount });
      where.OR = or;
    }

    const rows = await prisma.bankTransaction.findMany({
      where,
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take: DEPOSIT_PAGE_SIZE + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        amount: true,
        currency: true,
        occurredAt: true,
        counterpartName: true,
        counterpartReference: true,
        remittanceInfo: true,
      },
    });

    const hasMore = rows.length > DEPOSIT_PAGE_SIZE;
    const page = hasMore ? rows.slice(0, DEPOSIT_PAGE_SIZE) : rows;

    return {
      ok: true,
      transactions: page.map((b) => ({
        id: b.id,
        occurredAt: b.occurredAt.toISOString(),
        amount: b.amount.toFixed(2),
        currency: b.currency,
        counterpartName: b.counterpartName,
        reference: b.counterpartReference ?? b.remittanceInfo ?? null,
      })),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  } catch (e) {
    console.error("[card] listUnmatchedIncomingBankTransactions failed", e);
    return { error: t("cards.admin.topUp.attach.loadFailed" as never) };
  }
}

// Set a card to any of the three statuses directly (block/unblock are the
// ACTIVE↔BLOCKED special cases; this also covers the INACTIVE transitions the
// quick actions can't reach). `reportedLost` mirrors the internal lost flag:
// omit to leave it untouched, true/false to set/clear it. CP is kept in sync;
// local stays authoritative and a future sync reconciles a CP failure.
export async function setCardStatusAction(input: {
  cardId: string;
  status: CardStatus;
  reportedLost?: boolean;
}): Promise<BlockCardResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  if (!["ACTIVE", "INACTIVE", "BLOCKED"].includes(input.status)) {
    return { error: t("cards.admin.errors.invalidStatus" as never) };
  }

  const card = await prisma.card.findFirst({
    where: { id: input.cardId, fundId: fund.id },
    select: {
      id: true,
      serialNumber: true,
      status: true,
      blockedAt: true,
      reportedLostAt: true,
    },
  });
  if (!card) return { error: t("cards.admin.errors.notFound" as never) };

  const now = new Date();
  const blockedAt =
    input.status === "BLOCKED" ? (card.blockedAt ?? now) : null;
  const reportedLostAt =
    input.reportedLost === undefined
      ? card.reportedLostAt
      : input.reportedLost
        ? (card.reportedLostAt ?? now)
        : null;

  await prisma.card.update({
    where: { id: card.id },
    data: { status: input.status, blockedAt, reportedLostAt },
  });

  try {
    await getCitizenPayClient(fund).setCardStatus(
      card.serialNumber,
      input.status,
    );
  } catch (e) {
    console.error("[citizenpay] setCardStatus failed", e);
  }

  revalidatePath("/cards");
  revalidatePath(`/cards/${card.id}`);
  revalidatePath("/members");
  return { ok: true };
}

export type SetCardsStatusResult =
  | { ok: true; count: number }
  | { error: string };

// Bulk status edit from the cards list — set the same status on every selected
// card. Same dimensions as the single-card action, minus the per-card lost-flag
// nuance (bulk is status-only): blockedAt is set when blocking, cleared
// otherwise; reportedLostAt is left untouched. All cards are fund-scoped, and
// each is mirrored to CitizenPay fail-soft (a CP miss is logged; local stays
// authoritative and a future sync reconciles).
export async function setCardsStatusAction(input: {
  cardIds: string[];
  status: CardStatus;
}): Promise<SetCardsStatusResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  if (!["ACTIVE", "INACTIVE", "BLOCKED"].includes(input.status)) {
    return { error: t("cards.admin.errors.invalidStatus" as never) };
  }

  const ids = [...new Set(input.cardIds)].filter(Boolean);
  if (ids.length === 0) {
    return { error: t("cards.admin.bulk.errors.none" as never) };
  }

  const cards = await prisma.card.findMany({
    where: { id: { in: ids }, fundId: fund.id },
    select: { id: true, serialNumber: true },
  });
  if (cards.length === 0) {
    return { error: t("cards.admin.bulk.errors.none" as never) };
  }

  const now = new Date();
  await prisma.card.updateMany({
    where: { id: { in: cards.map((c) => c.id) }, fundId: fund.id },
    data: {
      status: input.status,
      blockedAt: input.status === "BLOCKED" ? now : null,
    },
  });

  const cp = getCitizenPayClient(fund);
  await Promise.allSettled(
    cards.map(async (c) => {
      try {
        await cp.setCardStatus(c.serialNumber, input.status);
      } catch (e) {
        console.error("[citizenpay] setCardStatus (bulk) failed", c.serialNumber, e);
      }
    }),
  );

  revalidatePath("/cards");
  revalidatePath("/members");
  return { ok: true, count: cards.length };
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
  const existing = await prisma.card.findFirst({
    where: { serialNumber: { equals: input.serialNumber, mode: "insensitive" } },
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
        number: await nextCardNumber(fund.id),
        holderName: null,
        status: detail.status,
        sourceSerial: detail.sourceSerial,
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
  number: number | null;
  account: string | null;
  holderName: string | null;
  status: CardStatus;
};

// Typeahead backing the activate-member dialog. Returns unattached cards
// (memberId is null) in the current fund matching the query against either the
// serial number (case-insensitive contains) or the per-fund card number (exact,
// when the term is all digits) — admin picks one to link instead of free-typing
// a serial. With an empty query we surface the most-recently-imported cards so
// the operator has something to scroll if they don't have the card in hand.
const UNATTACHED_LIMIT = 12;

export async function searchUnattachedCardsAction(
  q: string,
): Promise<UnattachedCardHit[]> {
  const { fund } = await requireFundRole("ADMIN");
  const term = q.trim();
  // An all-digits term may be a card number — match it exactly alongside the
  // serial substring match.
  const asNumber = /^\d+$/.test(term) ? Number(term) : null;
  const where = {
    fundId: fund.id,
    memberId: null,
    ...(term.length > 0
      ? {
          OR: [
            { serialNumber: { contains: term, mode: "insensitive" as const } },
            ...(asNumber !== null ? [{ number: asNumber }] : []),
          ],
        }
      : {}),
  };
  const cards = await prisma.card.findMany({
    where,
    select: {
      id: true,
      serialNumber: true,
      number: true,
      account: true,
      holderName: true,
      status: true,
    },
    orderBy: { createdAt: "desc" },
    take: UNATTACHED_LIMIT,
  });
  return cards;
}

// =============================================================================
// Card numbering — the per-fund 1…N number members encode in their Belgian
// structured communication. Auto-assigned at creation; admins can edit a
// single card or bulk-import a serial→number CSV here.
// =============================================================================

export type SetCardNumberResult = { ok: true } | { error: string };

export async function setCardNumberAction(input: {
  cardId: string;
  number: number | null;
}): Promise<SetCardNumberResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const card = await prisma.card.findFirst({
    where: { id: input.cardId, fundId: fund.id },
    select: { id: true },
  });
  if (!card) return { error: t("cards.admin.number.errors.notFound" as never) };

  const number = input.number;
  if (number !== null && (!Number.isInteger(number) || number < 1)) {
    return { error: t("cards.admin.number.errors.invalid" as never) };
  }

  // Reject a number already held by another card — the admin resolves the
  // clash explicitly (single edits don't silently steal; CSV import does the
  // bulk swap with displacement reporting).
  if (number !== null) {
    const clash = await prisma.card.findFirst({
      where: { fundId: fund.id, number, id: { not: card.id } },
      select: { id: true },
    });
    if (clash) return { error: t("cards.admin.number.errors.taken" as never) };
  }

  await prisma.card.update({ where: { id: card.id }, data: { number } });
  revalidatePath("/cards");
  return { ok: true };
}

export type SetCardSourceResult = { ok: true } | { error: string };

// Set (or clear) the card this card pulls from when its own balance can't
// cover a charge ("source card"). The relationship lives on CitizenPay —
// we don't mirror it locally; the detail page reads it back via
// `getCardSource`. Both cards are fund-scoped here, and CP enforces the
// same ownership rule on its side.
export async function setCardSourceAction(input: {
  cardId: string;
  sourceCardId: string | null;
}): Promise<SetCardSourceResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const card = await prisma.card.findFirst({
    where: { id: input.cardId, fundId: fund.id },
    select: { id: true, serialNumber: true },
  });
  if (!card) return { error: t("cards.admin.source.errors.notFound" as never) };

  let sourceSerial: string | null = null;
  if (input.sourceCardId !== null) {
    if (input.sourceCardId === card.id) {
      return { error: t("cards.admin.source.errors.self" as never) };
    }
    const source = await prisma.card.findFirst({
      where: { id: input.sourceCardId, fundId: fund.id },
      select: { serialNumber: true },
    });
    if (!source) {
      return { error: t("cards.admin.source.errors.sourceNotFound" as never) };
    }
    sourceSerial = source.serialNumber;
  }

  try {
    await getCitizenPayClient(fund).setCardSource(
      card.serialNumber,
      sourceSerial,
    );
  } catch (e) {
    console.error("[citizenpay] setCardSource failed", e);
    return { error: t("cards.admin.source.errors.failed" as never) };
  }

  // Write through to the local display cache (the cards list renders from
  // Prisma). CP stays authoritative; sync heals any drift.
  await prisma.card.update({
    where: { id: card.id },
    data: { sourceSerial },
  });

  revalidatePath("/cards");
  revalidatePath(`/cards/${card.id}`);
  return { ok: true };
}

export type ImportCardNumbersResult =
  | { error: string }
  | {
      ok: true;
      applied: number;
      provisioned: number;
      displaced: number;
      skipped: string[];
    };

// Bulk serial→number mapping from a CSV with headers. The admin picks which
// header is the serial and which is the number; we map each row's serial to
// its number. Numbers and serials must be unique within the CSV.
//
// Serials with no local card are provisioned: registered with CitizenPay in
// one bulk call, then created locally (account hydrated per-serial). Applying
// frees any number currently held elsewhere (those cards become unnumbered —
// reported as `displaced`). Serials that can't be provisioned (fund not
// connected to CP, or CP rejected them) are reported as `skipped`.
export async function importCardNumbersAction(input: {
  csv: string;
  serialColumn: string;
  numberColumn: string;
}): Promise<ImportCardNumbersResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const { headers, rows: csvRows } = parseCsv(input.csv);
  const si = headers.indexOf(input.serialColumn);
  const ni = headers.indexOf(input.numberColumn);
  if (si === -1 || ni === -1) {
    return {
      error: t("cards.admin.numberImport.errors.columnMissing" as never),
    };
  }

  const rows: { serial: string; number: number }[] = [];
  const seenSerials = new Set<string>();
  const seenNumbers = new Set<number>();
  for (const r of csvRows) {
    const serial = normalizeSerial(r[si] ?? "");
    const num = Number((r[ni] ?? "").trim());
    if (!serial || !Number.isInteger(num) || num < 1) continue; // blank/junk
    if (seenSerials.has(serial) || seenNumbers.has(num)) {
      return { error: t("cards.admin.numberImport.errors.duplicate" as never) };
    }
    seenSerials.add(serial);
    seenNumbers.add(num);
    rows.push({ serial, number: num });
  }
  if (rows.length === 0) {
    return { error: t("cards.admin.numberImport.errors.empty" as never) };
  }

  // Map existing fund cards by NORMALISED serial so a re-import finds a card
  // regardless of the case it was stored in — never creating a case-variant
  // duplicate. (rows[].serial is already normalised.)
  const fundCards = await prisma.card.findMany({
    where: { fundId: fund.id },
    select: { id: true, serialNumber: true },
  });
  const idByNormSerial = new Map(
    fundCards.map((c) => [normalizeSerial(c.serialNumber), c.id]),
  );
  const idBySerial = new Map<string, string>();
  for (const r of rows) {
    const id = idByNormSerial.get(r.serial);
    if (id) idBySerial.set(r.serial, id);
  }

  // Serials with no local card: provision them at CitizenPay (one bulk call),
  // hydrate each account, and create the local row. Numbers are assigned below
  // in the displacement loop along with the existing cards.
  const missing = rows
    .filter((r) => !idBySerial.has(r.serial))
    .map((r) => r.serial);
  let provisioned = 0;
  const skipped: string[] = [];
  if (missing.length > 0) {
    if (!fund.citizenPayFundId) {
      skipped.push(...missing); // not connected to CP — can't provision
    } else {
      try {
        const cp = getCitizenPayClient(fund);
        await cp.bulkCreateCards(missing);
        for (const serial of missing) {
          const detail = await cp.getCitizenPayCard(serial).catch(() => null);
          try {
            const created = await prisma.card.create({
              data: {
                fundId: fund.id,
                memberId: null,
                serialNumber: serial,
                account: detail?.account ?? null,
                status: detail?.status ?? "INACTIVE",
                issuedAt: new Date(),
              },
              select: { id: true },
            });
            idBySerial.set(serial, created.id);
            provisioned++;
          } catch (e) {
            // Raced with another create — re-find within THIS fund only. A
            // serial owned by another fund (global @unique) is left untouched.
            const existing = await prisma.card.findFirst({
              where: { fundId: fund.id, serialNumber: serial },
              select: { id: true },
            });
            if (existing) {
              idBySerial.set(serial, existing.id);
              provisioned++;
            } else {
              console.error("[card.numberImport] provision failed", serial, e);
              skipped.push(serial);
            }
          }
        }
      } catch (e) {
        console.error("[card.numberImport] bulkCreate failed", e);
        skipped.push(...missing);
      }
    }
  }

  const toApply = rows.filter((r) => idBySerial.has(r.serial));
  if (toApply.length === 0) {
    return { error: t("cards.admin.numberImport.errors.noMatches" as never) };
  }

  const targetNumbers = toApply.map((r) => r.number);
  const targetCardIds = toApply.map((r) => idBySerial.get(r.serial)!);

  // Cards (other than our targets) that will lose their number to a target —
  // reported as `displaced`.
  const displaced = await prisma.card.count({
    where: {
      fundId: fund.id,
      number: { in: targetNumbers },
      id: { notIn: targetCardIds },
    },
  });

  // Two statements in one batch transaction (a per-row update loop timed out at
  // ~200 cards on the 5s interactive limit): first free every number we're
  // about to assign — held by a target or any other card — then set them all in
  // a single UPDATE ... FROM (VALUES ...). The free-first step avoids transient
  // @@unique([fundId, number]) collisions mid-swap.
  const assignments = Prisma.join(
    toApply.map(
      (r) => Prisma.sql`(${idBySerial.get(r.serial)!}::text, ${r.number}::int)`,
    ),
  );
  await prisma.$transaction([
    prisma.card.updateMany({
      where: {
        fundId: fund.id,
        OR: [{ number: { in: targetNumbers } }, { id: { in: targetCardIds } }],
      },
      data: { number: null },
    }),
    prisma.$executeRaw`
      UPDATE "Card" AS c
      SET "number" = v.num
      FROM (VALUES ${assignments}) AS v(id, num)
      WHERE c.id = v.id AND c."fundId" = ${fund.id}
    `,
  ]);

  revalidatePath("/cards");
  return { ok: true, applied: toApply.length, provisioned, displaced, skipped };
}

// =============================================================================
// Unassign a card from its member
// =============================================================================
// Detach a card from the member it's bound to (e.g. lost / defective card being
// retired). Clears `Card.memberId`; if the card was the member's primary, also
// clears `Member.primaryCardId` so the member drops back into the "no primary"
// state and the assign-card flow (activateMemberAction) can give them a
// replacement primary. Balance is left untouched — move it first with
// transferBetweenCardsAction if it should follow the holder.

export type UnassignCardResult = { ok: true } | { error: string };

export async function unassignCardAction(input: {
  cardId: string;
}): Promise<UnassignCardResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const card = await prisma.card.findFirst({
    where: { id: input.cardId, fundId: fund.id },
    select: { id: true, memberId: true },
  });
  if (!card) return { error: t("cards.admin.unassign.errors.notFound" as never) };
  if (!card.memberId) {
    return { error: t("cards.admin.unassign.errors.notAssigned" as never) };
  }
  const memberId = card.memberId;

  await prisma.$transaction([
    prisma.card.update({
      where: { id: card.id },
      data: { memberId: null },
    }),
    // Only clears the pointer when this card actually was the primary — a
    // no-op for secondary (dependant) cards.
    prisma.member.updateMany({
      where: { id: memberId, primaryCardId: card.id },
      data: { primaryCardId: null },
    }),
  ]);

  revalidatePath("/cards");
  revalidatePath(`/cards/${card.id}`);
  revalidatePath("/members");
  revalidatePath(`/members/${memberId}`);
  return { ok: true };
}

// =============================================================================
// Card-to-card balance transfer
// =============================================================================
// Move a balance between two cards in the same fund — e.g. carrying a holder's
// remaining funds from a lost card onto its replacement. Card accounts are
// CitizenPay-issued wallets the minter doesn't own, so we can't sign a real
// ERC20 transfer the way token accounts do (accountTransferAction); instead we
// compose the two primitives the minter CAN do via its token roles: mint to the
// destination, then burn from the source. Recorded as two TokenOperation rows
// (the credit MINT + the debit BURN), each tagged CARD_TRANSFER so the audit
// log reads as one logical transfer.
//
// Order is mint-first on purpose: if the bundler is down the credit leg fails
// and we abort having moved nothing. The only partial state is the (very
// unlikely) credit-succeeds-then-debit-fails window, which leaves the holder
// made whole and merely over-issues the fund by the amount — a CONFIRMED mint +
// FAILED burn the operator can reconcile, never a holder losing money.

export type TransferBetweenCardsResult =
  | { ok: true; txHash: string }
  | { error: string; field?: "amount" | "toCard" };

const CardTransferSchema = z.object({
  fromCardId: z.string().min(1),
  toCardId: z.string().min(1),
  amount: z
    .string()
    .regex(/^\d+(\.\d{1,2})?$/, { error: "cards.admin.errors.amountInvalid" })
    .refine((v) => Number(v) > 0, {
      error: "cards.admin.errors.amountPositive",
    }),
});

export async function transferBetweenCardsAction(input: {
  fromCardId: string;
  toCardId: string;
  amount: string;
}): Promise<TransferBetweenCardsResult> {
  const t = await getTranslations();
  const { fund, user } = await requireFundRole("ADMIN");

  const parsed = CardTransferSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      error: t(issue.message as never),
      field: issue.path[0] === "amount" ? "amount" : undefined,
    };
  }
  if (parsed.data.fromCardId === parsed.data.toCardId) {
    return {
      error: t("cards.admin.transfer.errors.sameCard" as never),
      field: "toCard",
    };
  }
  if (!fund.tokenAddress || fund.tokenDecimals == null) {
    return { error: t("cards.admin.errors.tokenNotConfigured" as never) };
  }

  const cardSelect = {
    id: true,
    account: true,
    memberId: true,
    member: { select: { tierId: true } },
  } as const;
  const [from, to] = await Promise.all([
    prisma.card.findFirst({
      where: { id: parsed.data.fromCardId, fundId: fund.id },
      select: cardSelect,
    }),
    prisma.card.findFirst({
      where: { id: parsed.data.toCardId, fundId: fund.id },
      select: cardSelect,
    }),
  ]);
  if (!from) return { error: t("cards.admin.errors.notFound" as never) };
  if (!to) {
    return {
      error: t("cards.admin.transfer.errors.targetNotFound" as never),
      field: "toCard",
    };
  }
  if (!from.account || !to.account) {
    return { error: t("cards.admin.errors.noAccount" as never) };
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

  // --- Credit leg: mint to the destination card. ---
  const mintOp = await prisma.tokenOperation.create({
    data: {
      fundId: fund.id,
      type: "MINT",
      memberId: to.memberId,
      account: to.account,
      amount: parsed.data.amount,
      tierId: to.member?.tierId ?? null,
      status: "PENDING",
    },
  });
  let mintTxHash: string;
  try {
    const { txHash, userOpHash } = await mintToken({
      fund: fund as FundMinterContext,
      to: to.account as `0x${string}`,
      amount: amountUnits,
    });
    mintTxHash = txHash;
    await prisma.tokenOperation.update({
      where: { id: mintOp.id },
      data: { status: "CONFIRMED", txHash, confirmedAt: new Date() },
    });
    await resolveOrEnqueueAnnotation({
      fundId: fund.id,
      chainId: fund.tokenChainId,
      userOpHash,
      kind: ANNOTATION_TRIGGERS.cardTransfer,
      trigger: ANNOTATION_TRIGGERS.cardTransfer,
      triggeredByUserId: user.id,
    });
  } catch (e) {
    const errorMessage =
      e instanceof UserOpError ? `${e.code}: ${e.message}` : String(e);
    await prisma.tokenOperation.update({
      where: { id: mintOp.id },
      data: { status: "FAILED", errorMessage },
    });
    console.error("[card] transfer mint leg failed", mintOp.id, e);
    return { error: t("cards.admin.transfer.errors.failed" as never) };
  }

  // --- Debit leg: burn from the source card. ---
  const burnOp = await prisma.tokenOperation.create({
    data: {
      fundId: fund.id,
      type: "BURN",
      memberId: from.memberId,
      account: from.account,
      amount: parsed.data.amount,
      tierId: from.member?.tierId ?? null,
      status: "PENDING",
    },
  });
  try {
    const { txHash, userOpHash } = await burnFromToken({
      fund: fund as FundMinterContext,
      from: from.account as `0x${string}`,
      amount: amountUnits,
    });
    await prisma.tokenOperation.update({
      where: { id: burnOp.id },
      data: { status: "CONFIRMED", txHash, confirmedAt: new Date() },
    });
    await resolveOrEnqueueAnnotation({
      fundId: fund.id,
      chainId: fund.tokenChainId,
      userOpHash,
      kind: ANNOTATION_TRIGGERS.cardTransfer,
      trigger: ANNOTATION_TRIGGERS.cardTransfer,
      triggeredByUserId: user.id,
    });
  } catch (e) {
    // Credit already landed — the holder has their funds. Surface a distinct
    // error so the operator knows the source still needs draining; the FAILED
    // burn row carries the detail for reconciliation.
    const errorMessage =
      e instanceof UserOpError ? `${e.code}: ${e.message}` : String(e);
    await prisma.tokenOperation.update({
      where: { id: burnOp.id },
      data: { status: "FAILED", errorMessage },
    });
    console.error("[card] transfer burn leg failed", burnOp.id, e);
    revalidatePath("/cards");
    revalidatePath(`/cards/${from.id}`);
    revalidatePath(`/cards/${to.id}`);
    return { error: t("cards.admin.transfer.errors.debitFailed" as never) };
  }

  revalidatePath("/cards");
  revalidatePath(`/cards/${from.id}`);
  revalidatePath(`/cards/${to.id}`);
  if (from.memberId) revalidatePath(`/members/${from.memberId}`);
  if (to.memberId) revalidatePath(`/members/${to.memberId}`);
  revalidatePath("/token");
  return { ok: true, txHash: mintTxHash };
}

// Typeahead backing the card-to-card transfer destination picker. Returns
// fund cards that have a CP account (so they can receive a mint), excluding the
// source card. Matches serial (case-insensitive contains), card number (exact,
// digits) or holder name (case-insensitive contains).
export type TransferTargetHit = {
  id: string;
  serialNumber: string;
  number: number | null;
  holderName: string | null;
  status: CardStatus;
};

export async function searchTransferTargetCardsAction(input: {
  excludeCardId: string;
  q: string;
}): Promise<TransferTargetHit[]> {
  const { fund } = await requireFundRole("ADMIN");
  const term = input.q.trim();
  const asNumber = /^\d+$/.test(term) ? Number(term) : null;
  const cards = await prisma.card.findMany({
    where: {
      fundId: fund.id,
      id: { not: input.excludeCardId },
      account: { not: null },
      ...(term.length > 0
        ? {
            OR: [
              { serialNumber: { contains: term, mode: "insensitive" as const } },
              { holderName: { contains: term, mode: "insensitive" as const } },
              ...(asNumber !== null ? [{ number: asNumber }] : []),
            ],
          }
        : {}),
    },
    select: {
      id: true,
      serialNumber: true,
      number: true,
      holderName: true,
      status: true,
    },
    orderBy: { createdAt: "desc" },
    take: 12,
  });
  return cards;
}
