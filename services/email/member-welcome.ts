// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { getTranslations } from "next-intl/server";

import { prisma } from "@/services/db/prisma";
import { sendMemberWelcome } from "@/services/email/transactional";

// The MEMBER_WELCOME email after a member verified their address — queued
// once per member (idempotency key) and sent through Resend. Shared by the
// /join verification page (GET) and the member-login confirmation action
// (POST, services/member/auth-actions.ts). Signup-flow email: deliberately
// ignores the member-email pause — the member just verified. It carries no
// payment reference (the member has no card yet; the reference is the card
// UID, delivered with the card).

export type WelcomeFundContext = {
  id: string;
  name: string;
  primaryColor: string | null;
  logoUrl: string | null;
};

export async function dispatchMemberWelcome(
  fund: WelcomeFundContext,
  memberId: string,
): Promise<void> {
  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: { id: true, email: true, firstName: true },
  });
  if (!member?.email) return;

  const t = await getTranslations("members.signup.emailTemplates.welcome");
  const subject = t("subject", { fundName: fund.name });
  const emailRow = await prisma.email.create({
    data: {
      fundId: fund.id,
      type: "MEMBER_WELCOME",
      toEmail: member.email,
      memberId: member.id,
      idempotencyKey: `MEMBER_WELCOME:member:${member.id}`,
      subject,
    },
  });
  await sendMemberWelcome({
    emailId: emailRow.id,
    fundId: fund.id,
    toEmail: member.email,
    fund: {
      name: fund.name,
      primaryColor: fund.primaryColor,
      logoUrl: fund.logoUrl,
    },
    firstName: member.firstName,
  });
}

/** Queue + send, swallowing everything but logging the unexpected (P2002 = already sent). */
export async function dispatchMemberWelcomeSafe(
  fund: WelcomeFundContext,
  memberId: string,
): Promise<void> {
  try {
    await dispatchMemberWelcome(fund, memberId);
  } catch (e) {
    if ((e as { code?: string }).code !== "P2002") {
      console.error("[verify-email] welcome dispatch failed", e);
    }
  }
}
