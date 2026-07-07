// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";

import { requireFundRole } from "@/services/auth/dal";
import { prisma } from "@/services/db/prisma";

import { contributionApplies, isBelowTierMinimum } from "./contribution";
import { EditMemberProfileSchema } from "./schema";

export type EditMemberProfileField =
  | "firstName"
  | "lastName"
  | "email"
  | "phone"
  | "address"
  | "postalCode"
  | "city"
  | "iban"
  | "notes"
  | "householdAdults"
  | "householdChildren"
  | "contributionAmount";

export type UpdateMemberProfileResult =
  | { ok: true }
  | { error: string; field?: EditMemberProfileField };

// Admin edit of a member's core record (identity, address, household,
// banking IBAN, notes). Tier and status are handled by their own actions —
// not touched here. Email is per-fund unique, so a collision surfaces as a
// field error rather than an unhandled P2002.
export async function updateMemberProfileAction(
  input: unknown,
): Promise<UpdateMemberProfileResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("OPERATOR");

  const parsed = EditMemberProfileSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      error: t(issue.message as never),
      field: issue.path[0] as EditMemberProfileField | undefined,
    };
  }

  const memberId =
    typeof input === "object" && input !== null && "memberId" in input
      ? (input as { memberId?: unknown }).memberId
      : undefined;
  if (typeof memberId !== "string") {
    return { error: t("members.admin.errors.notFound" as never) };
  }

  const member = await prisma.member.findFirst({
    where: { id: memberId, fundId: fund.id },
    select: { id: true, tier: { select: { minContribution: true } } },
  });
  if (!member) return { error: t("members.admin.errors.notFound" as never) };

  // Normalise optional text: trimmed empty string → null so we don't store
  // empty strings that read as "set" downstream.
  const orNull = (v: string | undefined) => (v && v.length > 0 ? v : null);

  // Committed contribution (issue #82): only applies to FIXED_PERIOD funds with
  // tiers — drop any value otherwise. When it applies: empty → null (use the
  // tier target), and a set value is floored against the member's current tier
  // minimum (the schema can't do this since the tier lives outside the form).
  // Tier-less members have no floor. See services/member/contribution.ts.
  const tierCount = await prisma.allocationTier.count({
    where: { fundId: fund.id, archivedAt: null },
  });
  const applies = contributionApplies(fund.allocationMode, tierCount);
  const contributionAmount = applies
    ? orNull(parsed.data.contributionAmount)
    : null;
  if (
    contributionAmount !== null &&
    isBelowTierMinimum(
      Number(contributionAmount),
      member.tier ? Number(member.tier.minContribution) : null,
    )
  ) {
    return {
      error: t("members.admin.edit.errors.amountBelowMin" as never, {
        min: member.tier!.minContribution.toString(),
      } as never),
      field: "contributionAmount",
    };
  }

  try {
    await prisma.member.update({
      where: { id: member.id },
      data: {
        firstName: parsed.data.firstName,
        lastName: parsed.data.lastName,
        email: parsed.data.email,
        phone: orNull(parsed.data.phone),
        address: orNull(parsed.data.address),
        postalCode: orNull(parsed.data.postalCode),
        city: orNull(parsed.data.city),
        iban: orNull(parsed.data.iban),
        notes: orNull(parsed.data.notes),
        householdAdults: parsed.data.householdAdults,
        householdChildren: parsed.data.householdChildren,
        contributionAmount,
      },
    });
  } catch (e) {
    if (isP2002For(e, "email")) {
      return {
        error: t("members.admin.errors.emailTaken" as never),
        field: "email",
      };
    }
    throw e;
  }

  revalidatePath("/members");
  revalidatePath(`/members/${member.id}`);
  return { ok: true };
}

function isP2002For(e: unknown, field: string): boolean {
  if (!(e instanceof Error) || !("code" in e)) return false;
  if ((e as { code?: string }).code !== "P2002") return false;
  const meta = (e as { meta?: { target?: unknown } }).meta;
  if (!meta?.target) return false;
  const target = Array.isArray(meta.target) ? meta.target : [meta.target];
  return target.some((t) => typeof t === "string" && t.includes(field));
}
