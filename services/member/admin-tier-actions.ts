// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";

import { requireFundRole } from "@/services/auth/dal";
import { prisma } from "@/services/db/prisma";

export type AssignTierResult = { ok: true } | { error: string };

export async function assignTierAction(input: {
  memberId: string;
  tierId: string | null;
}): Promise<AssignTierResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("OPERATOR");

  const member = await prisma.member.findFirst({
    where: { id: input.memberId, fundId: fund.id },
    select: { id: true },
  });
  if (!member) return { error: t("members.admin.errors.notFound" as never) };

  if (input.tierId) {
    const tier = await prisma.allocationTier.findFirst({
      where: { id: input.tierId, fundId: fund.id, archivedAt: null },
      select: { id: true },
    });
    if (!tier) {
      return { error: t("members.admin.errors.tierNotFound" as never) };
    }
  }

  await prisma.member.update({
    where: { id: member.id },
    data: { tierId: input.tierId },
  });

  revalidatePath("/members");
  return { ok: true };
}
