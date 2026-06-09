"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";
import { parseUnits } from "viem";
import { z } from "zod";

import { requireFundRole } from "@/services/auth/dal";
import { getCitizenPayClient } from "@/services/citizenpay/client";
import { prisma } from "@/services/db/prisma";
import {
  annotateTransaction,
  ANNOTATION_TRIGGERS,
} from "@/services/transaction-annotation/annotate";
import { resolveOrEnqueueAnnotation } from "@/services/transaction-annotation/pending";
import {
  burnFromToken,
  mintToken,
  UserOpError,
  type FundMinterContext,
} from "@/services/token/userop";

import {
  ManualBurnDirectSchema,
  ManualMintDirectSchema,
} from "./schemas";

export type ManualMintResult =
  | { ok: true }
  | { error: string; field?: "amount" };

const ManualMintSchema = z.object({
  memberId: z.string().min(1),
  amount: z
    .string()
    .regex(/^\d+(\.\d{1,2})?$/, {
      error: "tokenOps.errors.amountInvalid",
    })
    .refine((v) => Number(v) > 0, {
      error: "tokenOps.errors.amountPositive",
    }),
  note: z.string().optional(),
});

// Manual mint to a member's primary card. Bypasses tier/bank-sync — used
// for corrections, ad-hoc top-ups, and migration imports. Creates a PENDING
// TokenOperation, submits to CP outside the transaction, then stamps the
// tx hash. If submission fails the row stays PENDING and the polling cron
// retries via services/token-operations/retry.ts.

export async function manualMintAction(input: {
  memberId: string;
  amount: string;
  note?: string;
}): Promise<ManualMintResult> {
  const t = await getTranslations();
  const { fund, user } = await requireFundRole("ADMIN");

  const parsed = ManualMintSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      error: t(issue.message as never),
      field: issue.path[0] === "amount" ? "amount" : undefined,
    };
  }

  const member = await prisma.member.findFirst({
    where: { id: parsed.data.memberId, fundId: fund.id },
    select: {
      id: true,
      status: true,
      tierId: true,
      primaryCard: { select: { id: true, account: true } },
    },
  });
  if (!member) return { error: t("tokenOps.errors.memberNotFound" as never) };
  if (member.status !== "ACTIVE") {
    return { error: t("tokenOps.errors.memberNotActive" as never) };
  }
  if (!member.primaryCard?.account) {
    return { error: t("tokenOps.errors.noPrimaryAccount" as never) };
  }

  const op = await prisma.tokenOperation.create({
    data: {
      fundId: fund.id,
      type: "MINT",
      memberId: member.id,
      account: member.primaryCard.account,
      amount: parsed.data.amount,
      tierId: member.tierId,
      status: "PENDING",
    },
  });

  const cp = getCitizenPayClient(fund);
  try {
    const submitted = await cp.submitMint({
      fundCitizenPayId: fund.citizenPayFundId,
      toAccount: member.primaryCard.account,
      amount: parsed.data.amount,
      reference: op.id,
    });
    await prisma.tokenOperation.update({
      where: { id: op.id },
      data: { txHash: submitted.txHash },
    });
    // CP-REST mint returns the final settlement hash — annotate directly.
    await annotateTransaction({
      fundId: fund.id,
      txHash: submitted.txHash,
      kind: ANNOTATION_TRIGGERS.adminManualMint,
      trigger: ANNOTATION_TRIGGERS.adminManualMint,
      triggeredByUserId: user.id,
    });
  } catch (e) {
    console.error("[citizenpay] submitMint failed for manual mint", e);
  }

  revalidatePath(`/members/${member.id}`);
  revalidatePath("/allocations");
  revalidatePath("/dashboard");
  return { ok: true };
}

// =============================================================================
// Direct mint/burn (to/from raw address)
// =============================================================================
// Bypasses member/card lookup — used from /token for ad-hoc on-chain
// corrections, dev/test minting, and any flow where the operator already
// knows the wallet address. Goes through the UserOp bundler
// (services/token/userop.ts), NOT CP's REST submitMint, because the
// recipient may not be a CP-registered card. Creates a TokenOperation
// row for audit regardless of outcome.

export type ManualMintDirectResult =
  | { ok: true; txHash: string; userOpHash: string }
  | { error: string; field?: "to" | "amount" | "note" };

// Audit context for the centralised annotation written on success. `trigger`
// is one of ANNOTATION_TRIGGERS; the acting admin is taken from the session.
// Callers that wrap this action (account moves, order settlement, payouts) pass
// their own trigger; a raw /token call defaults to ADMIN_DIRECT_*. When `audit`
// is absent the call is an operator's manual mint/burn, which MUST carry a note.
type DirectAudit = { trigger: string };

export async function manualMintDirectAction(
  input: {
    to: string;
    amount: string;
    note?: string;
  },
  audit?: DirectAudit,
): Promise<ManualMintDirectResult> {
  const t = await getTranslations();
  const { fund, user } = await requireFundRole("ADMIN");

  const parsed = ManualMintDirectSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      error: t(issue.message as never),
      field: issue.path[0] as "to" | "amount" | undefined,
    };
  }

  // Operator (manual) mints require an annotation note; internal callers carry
  // their own audit trigger instead.
  const note = input.note?.trim();
  if (!audit && !note) {
    return { error: t("tokenOps.errors.noteRequired" as never), field: "note" };
  }

  if (!fund.tokenAddress || fund.tokenDecimals == null) {
    return { error: t("tokenOps.errors.tokenNotConfigured" as never) };
  }

  let amountUnits: bigint;
  try {
    amountUnits = parseUnits(parsed.data.amount, fund.tokenDecimals);
  } catch {
    return {
      error: t("tokenOps.errors.amountInvalid" as never),
      field: "amount",
    };
  }

  const op = await prisma.tokenOperation.create({
    data: {
      fundId: fund.id,
      type: "MINT",
      account: parsed.data.to,
      amount: parsed.data.amount,
      status: "PENDING",
    },
  });

  try {
    const { txHash, userOpHash } = await mintToken({
      fund: fund as FundMinterContext,
      to: parsed.data.to as `0x${string}`,
      amount: amountUnits,
    });
    await prisma.tokenOperation.update({
      where: { id: op.id },
      data: { status: "CONFIRMED", txHash, confirmedAt: new Date() },
    });
    const trigger = audit?.trigger ?? ANNOTATION_TRIGGERS.adminDirectMint;
    await resolveOrEnqueueAnnotation({
      fundId: fund.id,
      chainId: fund.tokenChainId,
      userOpHash,
      kind: trigger,
      note: note ?? null,
      trigger,
      triggeredByUserId: user.id,
    });
    revalidatePath("/token");
    return { ok: true, txHash, userOpHash };
  } catch (e) {
    const errorMessage =
      e instanceof UserOpError ? `${e.code}: ${e.message}` : String(e);
    await prisma.tokenOperation.update({
      where: { id: op.id },
      data: { status: "FAILED", errorMessage },
    });
    console.error("[manualMintDirect] failed", op.id, e);
    return { error: t("tokenOps.errors.submitFailed" as never) };
  }
}

export type ManualBurnDirectResult =
  | { ok: true; txHash: string; userOpHash: string }
  | { error: string; field?: "from" | "amount" | "note" };

export async function manualBurnDirectAction(
  input: {
    from: string;
    amount: string;
    note?: string;
  },
  audit?: DirectAudit,
): Promise<ManualBurnDirectResult> {
  const t = await getTranslations();
  const { fund, user } = await requireFundRole("ADMIN");

  const parsed = ManualBurnDirectSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      error: t(issue.message as never),
      field: issue.path[0] as "from" | "amount" | undefined,
    };
  }

  // Operator (manual) burns require an annotation note; internal callers carry
  // their own audit trigger instead.
  const note = input.note?.trim();
  if (!audit && !note) {
    return { error: t("tokenOps.errors.noteRequired" as never), field: "note" };
  }

  if (!fund.tokenAddress || fund.tokenDecimals == null) {
    return { error: t("tokenOps.errors.tokenNotConfigured" as never) };
  }

  let amountUnits: bigint;
  try {
    amountUnits = parseUnits(parsed.data.amount, fund.tokenDecimals);
  } catch {
    return {
      error: t("tokenOps.errors.amountInvalid" as never),
      field: "amount",
    };
  }

  const op = await prisma.tokenOperation.create({
    data: {
      fundId: fund.id,
      type: "BURN",
      account: parsed.data.from,
      amount: parsed.data.amount,
      status: "PENDING",
    },
  });

  try {
    const { txHash, userOpHash } = await burnFromToken({
      fund: fund as FundMinterContext,
      from: parsed.data.from as `0x${string}`,
      amount: amountUnits,
    });
    await prisma.tokenOperation.update({
      where: { id: op.id },
      data: { status: "CONFIRMED", txHash, confirmedAt: new Date() },
    });
    const trigger = audit?.trigger ?? ANNOTATION_TRIGGERS.adminDirectBurn;
    await resolveOrEnqueueAnnotation({
      fundId: fund.id,
      chainId: fund.tokenChainId,
      userOpHash,
      kind: trigger,
      note: note ?? null,
      trigger,
      triggeredByUserId: user.id,
    });
    revalidatePath("/token");
    return { ok: true, txHash, userOpHash };
  } catch (e) {
    const errorMessage =
      e instanceof UserOpError ? `${e.code}: ${e.message}` : String(e);
    await prisma.tokenOperation.update({
      where: { id: op.id },
      data: { status: "FAILED", errorMessage },
    });
    console.error("[manualBurnDirect] failed", op.id, e);
    return { error: t("tokenOps.errors.submitFailed" as never) };
  }
}
