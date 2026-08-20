// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { requireFundRole } from "@/services/auth/dal";
import { prisma } from "@/services/db/prisma";

const DecimalString = z
  .string()
  .min(1)
  .regex(/^\d+(\.\d{1,2})?$/, { error: "tiers.errors.invalidAmount" });

const TierSchema = z
  .object({
    name: z.string().min(1, { error: "tiers.errors.nameRequired" }),
    minContribution: DecimalString,
    allocationAmount: DecimalString,
    maxContribution: DecimalString,
    position: z.number().int().min(0).default(0),
    // Withhold this tier from the public signup picker (issue #37). Admins can
    // still assign it and it still drives allocations — see the schema comment.
    hiddenAtSignup: z.boolean().default(false),
  })
  .refine(
    (v) =>
      Number(v.minContribution) <= Number(v.allocationAmount) &&
      Number(v.allocationAmount) <= Number(v.maxContribution),
    {
      error: "tiers.errors.orderingInvalid",
      path: ["allocationAmount"],
    },
  );

export type TierInput = z.infer<typeof TierSchema>;
export type TierMutationResult =
  | { error: string; field?: keyof TierInput }
  | { ok: true };

export async function createTierAction(
  input: TierInput,
): Promise<TierMutationResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const parsed = TierSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      error: t(issue.message as never),
      field: issue.path[0] as keyof TierInput | undefined,
    };
  }

  try {
    await prisma.allocationTier.create({
      data: { fundId: fund.id, ...parsed.data },
    });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") {
      return { error: t("tiers.errors.nameTaken" as never), field: "name" };
    }
    throw e;
  }

  revalidatePath("/allocations");
  revalidatePath("/dashboard");
  return { ok: true };
}

export async function updateTierAction(input: {
  tierId: string;
  data: TierInput;
}): Promise<TierMutationResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const parsed = TierSchema.safeParse(input.data);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      error: t(issue.message as never),
      field: issue.path[0] as keyof TierInput | undefined,
    };
  }

  const existing = await prisma.allocationTier.findFirst({
    where: { id: input.tierId, fundId: fund.id },
    select: { id: true },
  });
  if (!existing) return { error: t("tiers.errors.notFound" as never) };

  try {
    await prisma.allocationTier.update({
      where: { id: existing.id },
      data: parsed.data,
    });
  } catch (e) {
    if ((e as { code?: string }).code === "P2002") {
      return { error: t("tiers.errors.nameTaken" as never), field: "name" };
    }
    throw e;
  }

  revalidatePath("/allocations");
  revalidatePath("/dashboard");
  return { ok: true };
}

export async function archiveTierAction(input: {
  tierId: string;
}): Promise<TierMutationResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const existing = await prisma.allocationTier.findFirst({
    where: { id: input.tierId, fundId: fund.id },
    select: { id: true, _count: { select: { members: true } } },
  });
  if (!existing) return { error: t("tiers.errors.notFound" as never) };

  await prisma.allocationTier.update({
    where: { id: existing.id },
    data: { archivedAt: new Date() },
  });

  revalidatePath("/allocations");
  revalidatePath("/dashboard");
  return { ok: true };
}
