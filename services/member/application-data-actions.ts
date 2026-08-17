// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";

import { requireFundRole } from "@/services/auth/dal";
import { Prisma } from "@/services/db/generated/client";
import { prisma } from "@/services/db/prisma";
import { buildExtrasSchema } from "@/services/onboarding/extras-schema";
import { parseVisibleIf } from "@/services/onboarding/visibility";

import { mergeApplicationData } from "./application-data";
import type { ExtraValue } from "./schema";

// Editing the answers a member gave to a fund's custom signup questions.
//
// Until now `applicationData` was written once at signup and never again:
// the detail page rendered it read-only and no action could touch it. That was
// survivable while it only held optional extras, but it blocks moving anything
// real into it — an admin has to be able to fix a typo in a phone number.
//
// Gated at OPERATOR, matching the rest of member management (see AGENTS.md);
// the identity/profile columns have their own action in profile-actions.ts.

export type ApplicationDataResult =
  | { ok: true }
  | { error: string; field?: string };

export async function updateMemberApplicationDataAction(input: {
  memberId: string;
  values: Record<string, ExtraValue>;
}): Promise<ApplicationDataResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("OPERATOR");

  // Scoped by fundId: a member id alone is not proof of ownership.
  const member = await prisma.member.findFirst({
    where: { id: input.memberId, fundId: fund.id },
    select: { id: true, applicationData: true },
  });
  if (!member) {
    return { error: t("members.admin.errors.notFound" as never) };
  }

  // Only fields the fund actually asks for today are editable. Archived ones
  // are deliberately excluded from the schema but their stored answers are
  // preserved below — an archived question's history shouldn't be editable,
  // nor silently destroyed by saving the form that no longer shows it.
  // Builtin fields (address, postalCode, city, tierId) are excluded too —
  // they write to a typed Member column via EditProfileDialog/
  // MemberTierPicker, not to this JSON blob (see builtin-fields.ts). Without
  // this filter a submission naming a builtin's key would get merged into
  // applicationData while the typed column — and everything that reads it,
  // like the address on card-assigned emails — stayed untouched.
  const fields = await prisma.onboardingField.findMany({
    where: {
      fundId: fund.id,
      target: "MEMBER",
      archivedAt: null,
      builtinKey: null,
    },
    select: {
      key: true,
      type: true,
      required: true,
      label: true,
      visibleIf: true,
    },
  });

  const extraFields = fields.map((f) => ({
    ...f,
    visibleIf: parseVisibleIf(f.visibleIf),
  }));
  const parsed = buildExtrasSchema(extraFields).safeParse(input.values);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const key = typeof issue.path[0] === "string" ? issue.path[0] : undefined;
    const label = fields.find((f) => f.key === key)?.label ?? key ?? "";
    return {
      error: t(issue.message as never, { label } as never),
      field: key,
    };
  }

  const next = mergeApplicationData(
    (member.applicationData as Record<string, ExtraValue> | null) ?? {},
    fields.map((f) => f.key),
    parsed.data as Record<string, ExtraValue | undefined>,
  );

  await prisma.member.update({
    where: { id: member.id },
    data: {
      applicationData:
        Object.keys(next).length > 0
          ? (next as Prisma.InputJsonValue)
          : Prisma.JsonNull,
    },
  });

  revalidatePath(`/members/${member.id}`);
  return { ok: true };
}
