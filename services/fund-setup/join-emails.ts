// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { getTranslations } from "next-intl/server";

import { sendEmail } from "@/services/email/resend";

// The apex /join door's one email of its own. (The verification email a new
// account gets is Better Auth's, services/auth/better-auth.ts.)
//
// A submit whose address already has an account is answered by email, not on
// screen (join-actions.ts): the screen says only that an email went out, so
// a holder of a cohort code cannot use the form to learn which addresses have
// accounts. The inbox's owner — the only one who can act on it — gets the
// sign-in link that comes back to /new?code=.
export async function sendJoinExistingAccountEmail(args: {
  email: string;
  signInUrl: string;
}): Promise<void> {
  const t = await getTranslations("auth.emails.joinExistingAccount");
  const text = t("text", { url: args.signInUrl });
  await sendEmail({
    to: args.email,
    subject: t("subject"),
    text,
    html: `<p>${text.replace(/\n/g, "</p><p>")}</p>`,
  });
}
