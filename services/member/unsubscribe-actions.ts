// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";

import { prisma } from "@/services/db/prisma";
import { verifyUnsubscribeToken } from "./unsubscribe";

// Member-driven opt-out toggle (issue #40), invoked from the public
// /unsubscribe page. No session: the token IS the authentication — a valid
// signature proves the request is for that specific member. The page only
// renders buttons; the mutation runs here as a server action (never on GET) so
// an inbox link-scanner can't flip the flag by prefetching.

export type SetUnsubscribeResult =
  | { ok: true; unsubscribed: boolean }
  | { error: string };

export async function setReminderOptOutAction(input: {
  token: string;
  unsubscribe: boolean;
}): Promise<SetUnsubscribeResult> {
  const t = await getTranslations("unsubscribe");

  const memberId = verifyUnsubscribeToken(input.token);
  if (!memberId) return { error: t("errors.invalidLink") };

  const member = await prisma.member.findUnique({
    where: { id: memberId },
    select: { id: true },
  });
  if (!member) return { error: t("errors.invalidLink") };

  await prisma.member.update({
    where: { id: member.id },
    data: {
      emailUnsubscribed: input.unsubscribe,
      emailUnsubscribedAt: input.unsubscribe ? new Date() : null,
    },
  });

  return { ok: true, unsubscribed: input.unsubscribe };
}
