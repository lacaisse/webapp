// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { getCitizenPayClient } from "@/services/citizenpay/client";
import { Prisma } from "@/services/db/generated/client";
import { prisma } from "@/services/db/prisma";
import { annotateTransaction } from "@/services/transaction-annotation/annotate";

// Single-deposit tier allocation: mint a member's tier `allocationAmount` for
// one bank deposit. Shared by the PAY_AND_GO ingest path and manual
// attribution so both produce identical TokenOperation history (MINT + source
// link to the deposit). FIXED_PERIOD does NOT use this — it batch-mints at
// period close.
//
// Returns true if a mint was created (op row exists, regardless of whether the
// CP submission succeeded — a failed submit leaves the op PENDING with no
// txHash for a re-submit job). Returns false when there's nothing to mint (no
// tier, no target account, or the deposit is outside the tier's range).

export type AllocationFund = {
  id: string;
  citizenPayFundId: string;
  citizenPayApiKeyId: string | null;
  citizenPayApiKeyEnc: string | null;
};

export async function mintTierAllocation(args: {
  fund: AllocationFund;
  bankTransactionId: string;
  memberId: string;
  tierId: string | null;
  account: string | null;
  depositAmount: string;
  // Annotation audit fields. `trigger` is also used as the annotation kind.
  trigger: string;
  triggeredByUserId?: string | null;
}): Promise<boolean> {
  if (!args.tierId) return false; // no tier → no auto-mint
  if (!args.account) return false; // no target card account

  const tier = await prisma.allocationTier.findUnique({
    where: { id: args.tierId },
    select: {
      minContribution: true,
      maxContribution: true,
      allocationAmount: true,
    },
  });
  if (!tier) return false;

  const deposit = new Prisma.Decimal(args.depositAmount);
  if (deposit.lt(tier.minContribution) || deposit.gt(tier.maxContribution)) {
    return false; // out of range — admin reviews
  }

  // Op + source link in one transaction; CP submission outside (HTTP latency
  // shouldn't hold a DB lock).
  const op = await prisma.$transaction(async (tx) => {
    const created = await tx.tokenOperation.create({
      data: {
        fundId: args.fund.id,
        type: "MINT",
        memberId: args.memberId,
        account: args.account!,
        amount: tier.allocationAmount,
        tierId: args.tierId,
        status: "PENDING",
      },
    });
    await tx.tokenOperationSource.create({
      data: {
        bankTransactionId: args.bankTransactionId,
        tokenOperationId: created.id,
      },
    });
    return created;
  });

  try {
    const cp = getCitizenPayClient(args.fund);
    const submitted = await cp.submitMint({
      fundCitizenPayId: args.fund.citizenPayFundId,
      toAccount: args.account,
      amount: tier.allocationAmount.toString(),
      reference: op.id,
    });
    await prisma.tokenOperation.update({
      where: { id: op.id },
      data: { txHash: submitted.txHash },
    });
    await annotateTransaction({
      fundId: args.fund.id,
      txHash: submitted.txHash,
      kind: args.trigger,
      trigger: args.trigger,
      triggeredByUserId: args.triggeredByUserId ?? null,
    });
  } catch (e) {
    console.error("[allocate] submitMint failed", op.id, e);
    // Op stays PENDING with no txHash.
  }

  return true;
}
