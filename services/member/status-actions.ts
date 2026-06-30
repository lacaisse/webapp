// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";

import { requireFundRole } from "@/services/auth/dal";
import type { MemberStatus } from "@/services/db/generated/enums";
import { prisma } from "@/services/db/prisma";

import { MEMBER_STATUS_TRANSITIONS } from "./status-config";

// Admin status transitions are defined in status-config.ts (shared with the
// status-change dialog). Entering STOPPED stamps a leave date; leaving it
// clears it.

export type ChangeMemberStatusResult = { ok: true } | { error: string };

export async function changeMemberStatusAction(input: {
  memberId: string;
  status: MemberStatus;
}): Promise<ChangeMemberStatusResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("OPERATOR");

  const member = await prisma.member.findFirst({
    where: { id: input.memberId, fundId: fund.id },
    select: { id: true, status: true },
  });
  if (!member) return { error: t("members.admin.errors.notFound" as never) };

  const allowed = MEMBER_STATUS_TRANSITIONS[member.status];
  if (!allowed.includes(input.status) && member.status !== input.status) {
    return {
      error: t("members.admin.errors.invalidStatusTransition" as never),
    };
  }
  if (member.status === input.status) return { ok: true };

  await prisma.member.update({
    where: { id: member.id },
    data: {
      status: input.status,
      // Stamp `leftAt` on the way into STOPPED; clear it on the way out.
      leftAt:
        input.status === "STOPPED"
          ? new Date()
          : member.status === "STOPPED"
            ? null
            : undefined,
    },
  });

  revalidatePath("/members");
  return { ok: true };
}
