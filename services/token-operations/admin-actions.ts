"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireFundRole } from "@/services/auth/dal";
import { getCitizenPayClient } from "@/services/citizenpay/client";
import { prisma } from "@/services/db/prisma";

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
  const { fund } = await requireFundRole("ADMIN");

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

  const cp = getCitizenPayClient();
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
  } catch (e) {
    console.error("[citizenpay] submitMint failed for manual mint", e);
  }

  revalidatePath(`/members/${member.id}`);
  revalidatePath("/allocations");
  revalidatePath("/dashboard");
  return { ok: true };
}
