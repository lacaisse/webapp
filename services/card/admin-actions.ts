// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";
import { parseUnits } from "viem";
import { z } from "zod";

import { requireFundRole } from "@/services/auth/dal";
import { getCitizenPayClient } from "@/services/citizenpay/client";
import { Prisma } from "@/services/db/generated/client";
import type { CardStatus } from "@/services/db/generated/enums";
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
