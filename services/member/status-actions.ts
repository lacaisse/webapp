// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";

import { requireFundRole } from "@/services/auth/dal";
import { prisma } from "@/services/db/prisma";

// Admin status transitions. Allowed paths from the UI:
//   ACTIVE ↔ INACTIVE          (pause / resume)
//   ACTIVE | INACTIVE → LEFT   (resignation)
//   LEFT → ACTIVE              (returning member)
//
// INVITED / ONBOARDING aren't reachable from the UI — those states are
// owned by the signup + activation flows. Reverting back into them would
// confuse audit semantics (an active member can't un-activate).

const MANUAL_TRANSITIONS = {
  ACTIVE: new Set(["INACTIVE", "LEFT"] as const),
  INACTIVE: new Set(["ACTIVE", "LEFT"] as const),
  LEFT: new Set(["ACTIVE"] as const),
  INVITED: new Set<"INACTIVE" | "ACTIVE" | "LEFT">(),
  ONBOARDING: new Set<"INACTIVE" | "ACTIVE" | "LEFT">(),
} as const;

export type ChangeMemberStatusResult = { ok: true } | { error: string };

export async function changeMemberStatusAction(input: {
  memberId: string;
  status: "ACTIVE" | "INACTIVE" | "LEFT";
}): Promise<ChangeMemberStatusResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const member = await prisma.member.findFirst({
    where: { id: input.memberId, fundId: fund.id },
    select: { id: true, status: true },
  });
  if (!member) return { error: t("members.admin.errors.notFound" as never) };

  const allowed = MANUAL_TRANSITIONS[member.status];
  if (
    !(allowed as ReadonlySet<string>).has(input.status) &&
    member.status !== input.status
  ) {
    return {
      error: t("members.admin.errors.invalidStatusTransition" as never),
    };
  }
  if (member.status === input.status) return { ok: true };

  await prisma.member.update({
    where: { id: member.id },
    data: {
      status: input.status,
      // Stamp `leftAt` on the way into LEFT; clear it on the way out.
      leftAt:
        input.status === "LEFT"
          ? new Date()
          : member.status === "LEFT"
            ? null
            : undefined,
    },
  });

  revalidatePath("/members");
  return { ok: true };
}
