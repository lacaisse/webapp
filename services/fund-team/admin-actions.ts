// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { randomBytes } from "node:crypto";
import { getTranslations } from "next-intl/server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

import { requireFundRole, requireUser } from "@/services/auth/dal";
import { prisma } from "@/services/db/prisma";
import { sendFundInvited } from "@/services/email/transactional";
import { getFundUrl, requireCurrentFund } from "@/services/fund/server";
import {
  InviteFundMemberSchema,
  type InvitableRole,
  type InviteFundMemberInput,
} from "./schema";

// Staff-invite lifecycle. Co-administrators are FundMember rows; because
// FundMember.userId is a hard FK to a Better Auth User (created only at
// signup), an invite to someone with no account is stored as a pending
// FundInvite keyed by email and materialized on accept. See schema.prisma.

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export type InviteFundMemberResult =
  | { ok: true }
  | { error: string; field?: "email" | "role" };

export type FundTeamResult = { ok: true } | { error: string };

// OWNER may grant OWNER or ADMIN; ADMIN may grant ADMIN only.
function canGrant(actorRole: string, targetRole: InvitableRole): boolean {
  if (targetRole === "OWNER") return actorRole === "OWNER";
  return true; // ADMIN target — any ADMIN+ actor
}

export async function inviteFundMemberAction(
  input: InviteFundMemberInput,
): Promise<InviteFundMemberResult> {
  const t = await getTranslations();
  const { user, fund, membership } = await requireFundRole("ADMIN");

  const parsed = InviteFundMemberSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      error: t(issue.message as never),
      field: issue.path[0] as "email" | "role" | undefined,
    };
  }

  const email = parsed.data.email.trim().toLowerCase();
  const role = parsed.data.role;

  if (!canGrant(membership.role, role)) {
    return { error: t("team.errors.cannotGrantOwner" as never), field: "role" };
  }

  // Reject if the email already belongs to staff of this fund.
  const existing = await prisma.fundMember.findFirst({
    where: { fundId: fund.id, user: { email } },
    select: { id: true },
  });
  if (existing) {
    return { error: t("team.errors.alreadyMember" as never), field: "email" };
  }

  const token = randomBytes(32).toString("base64url");
  const subject = t("team.admin.email.invited.subject" as never, {
    fundName: fund.name,
  } as never);

  // Upsert on (fundId, email) so re-inviting replaces the prior pending
  // invite with a fresh token and clears any stale acceptance.
  const { invite, emailId } = await prisma.$transaction(async (tx) => {
    const invite = await tx.fundInvite.upsert({
      where: { fundId_email: { fundId: fund.id, email } },
      create: {
        fundId: fund.id,
        email,
        role,
        token,
        invitedById: user.id,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
      },
      update: {
        role,
        token,
        invitedById: user.id,
        expiresAt: new Date(Date.now() + INVITE_TTL_MS),
        acceptedAt: null,
        acceptedById: null,
      },
    });
    const emailRow = await tx.email.create({
      data: {
        fundId: fund.id,
        type: "FUND_INVITED",
        toEmail: email,
        idempotencyKey: `FUND_INVITED:invite:${invite.id}:${token}`,
        subject,
      },
    });
    return { invite, emailId: emailRow.id };
  });

  await sendFundInvited({
    emailId,
    toEmail: email,
    fund: {
      name: fund.name,
      primaryColor: fund.primaryColor,
      logoUrl: fund.logoUrl,
    },
    role,
    acceptUrl: `${getFundUrl(fund.domain)}/join-team?token=${encodeURIComponent(
      invite.token,
    )}`,
  });

  revalidatePath("/team");
  return { ok: true };
}

export async function changeFundMemberRoleAction(input: {
  membershipId: string;
  role: InvitableRole;
}): Promise<FundTeamResult> {
  const t = await getTranslations();
  const { fund, membership: actor } = await requireFundRole("ADMIN");

  if (input.role !== "OWNER" && input.role !== "ADMIN") {
    return { error: t("team.errors.roleInvalid" as never) };
  }

  const target = await prisma.fundMember.findFirst({
    where: { id: input.membershipId, fundId: fund.id },
    select: { id: true, role: true },
  });
  if (!target) return { error: t("team.errors.notFound" as never) };

  // ADMIN may not touch an OWNER, nor promote anyone to OWNER.
  if (target.role === "OWNER" && actor.role !== "OWNER") {
    return { error: t("team.errors.cannotModifyOwner" as never) };
  }
  if (!canGrant(actor.role, input.role)) {
    return { error: t("team.errors.cannotGrantOwner" as never) };
  }

  // Don't strip the last OWNER of their ownership.
  if (target.role === "OWNER" && input.role !== "OWNER") {
    const owners = await prisma.fundMember.count({
      where: { fundId: fund.id, role: "OWNER" },
    });
    if (owners <= 1) return { error: t("team.errors.lastOwner" as never) };
  }

  await prisma.fundMember.update({
    where: { id: target.id },
    data: { role: input.role },
  });

  revalidatePath("/team");
  return { ok: true };
}

export async function removeFundMemberAction(input: {
  membershipId: string;
}): Promise<FundTeamResult> {
  const t = await getTranslations();
  const { fund, membership: actor } = await requireFundRole("ADMIN");

  const target = await prisma.fundMember.findFirst({
    where: { id: input.membershipId, fundId: fund.id },
    select: { id: true, role: true },
  });
  if (!target) return { error: t("team.errors.notFound" as never) };

  if (target.role === "OWNER" && actor.role !== "OWNER") {
    return { error: t("team.errors.cannotModifyOwner" as never) };
  }

  if (target.role === "OWNER") {
    const owners = await prisma.fundMember.count({
      where: { fundId: fund.id, role: "OWNER" },
    });
    if (owners <= 1) return { error: t("team.errors.lastOwner" as never) };
  }

  await prisma.fundMember.delete({ where: { id: target.id } });

  revalidatePath("/team");
  return { ok: true };
}

export async function revokeFundInviteAction(input: {
  inviteId: string;
}): Promise<FundTeamResult> {
  const t = await getTranslations();
  const { fund } = await requireFundRole("ADMIN");

  const { count } = await prisma.fundInvite.deleteMany({
    where: { id: input.inviteId, fundId: fund.id, acceptedAt: null },
  });
  if (count === 0) return { error: t("team.errors.notFound" as never) };

  revalidatePath("/team");
  return { ok: true };
}

// Called from the public accept page once the visitor is logged in. Verifies
// the invite belongs to the current fund, hasn't expired/been used, and that
// the signed-in user's email matches, then materializes the FundMember.
export async function acceptFundInviteAction(input: {
  token: string;
}): Promise<FundTeamResult> {
  const t = await getTranslations();
  const user = await requireUser();
  const fund = await requireCurrentFund();

  const invite = await prisma.fundInvite.findFirst({
    where: { fundId: fund.id, token: input.token },
  });
  if (!invite || invite.acceptedAt) {
    return { error: t("team.errors.inviteInvalid" as never) };
  }
  if (invite.expiresAt.getTime() < Date.now()) {
    return { error: t("team.errors.inviteExpired" as never) };
  }
  if (user.email.toLowerCase() !== invite.email.toLowerCase()) {
    return { error: t("team.errors.emailMismatch" as never) };
  }

  await prisma.$transaction(async (tx) => {
    await tx.fundMember.upsert({
      where: { userId_fundId: { userId: user.id, fundId: fund.id } },
      create: { userId: user.id, fundId: fund.id, role: invite.role },
      update: { role: invite.role },
    });
    await tx.fundInvite.update({
      where: { id: invite.id },
      data: { acceptedAt: new Date(), acceptedById: user.id },
    });
  });

  redirect("/dashboard");
}
