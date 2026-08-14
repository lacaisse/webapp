"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireFundRole } from "@/services/auth/dal";
import { getCitizenPayClient } from "@/services/citizenpay/client";
import { prisma } from "@/services/db/prisma";
import { ANNOTATION_TRIGGERS } from "@/services/transaction-annotation/annotate";
import { resolveOrEnqueueAnnotation } from "@/services/transaction-annotation/pending";

import { burnDirect, mintDirect, type DirectAudit } from "./direct";

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
    // CP's top-up endpoint returns a userOp hash, not the settlement tx hash
    // the transfer history is keyed by — resolve it (or queue for the
    // annotation-resolve cron) so the annotation is visible.
    await resolveOrEnqueueAnnotation({
      fundId: fund.id,
      chainId: fund.tokenChainId,
      userOpHash: submitted.txHash,
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

// Host-scoped wrapper around `mintDirect` (services/token-operations/direct.ts),
// which holds the actual implementation so MCP tools — where the fund is a
// parameter, not the request host — run the exact same code path. `audit`
// carries the caller's ANNOTATION_TRIGGERS entry; a raw /token call has none
// and must supply a note instead.
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
  return mintDirect(
    { fund, userId: user.id, t: (key) => t(key as never) },
    input,
    audit,
  );
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
  return burnDirect(
    { fund, userId: user.id, t: (key) => t(key as never) },
    input,
    audit,
  );
}
