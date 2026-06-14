// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getLocale, getTranslations } from "next-intl/server";
import { sendEmail } from "@/services/email/resend";
import { upsertWaitlistEntry } from "./db";
import { WAITLIST_FUND_NAME_MAX, WaitlistSchema, type WaitlistInput } from "./schema";

export type WaitlistResult = { error: string } | { ok: true; message: string };

export async function joinWaitlistAction(
  input: WaitlistInput,
): Promise<WaitlistResult> {
  const t = await getTranslations();
  const parsed = WaitlistSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      error: t(issue.message as never, { max: WAITLIST_FUND_NAME_MAX } as never),
    };
  }

  const email = parsed.data.email.trim().toLowerCase();
  const fundName = parsed.data.fundName?.trim() || null;
  const locale = await getLocale();

  await upsertWaitlistEntry({ email, fundName, locale });

  // Confirmation email is best-effort — a Resend hiccup shouldn't make the
  // visitor think the signup failed (the row is already persisted). Log and
  // continue, mirroring how invite sends treat Resend errors.
  try {
    await sendEmail({
      to: email,
      subject: t("landing.waitlist.emails.confirm.subject"),
      text: t("landing.waitlist.emails.confirm.text"),
    });
  } catch (e) {
    console.error("waitlist confirmation email failed:", e);
  }

  return { ok: true, message: t("landing.waitlist.successBody") };
}
