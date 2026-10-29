// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { getTranslations } from "next-intl/server";
import { auth } from "./better-auth";
import { AttemptLimiter } from "./attempt-limiter";
import { getCurrentSession } from "./dal";
import { issueRecentAuthProof } from "./step-up";

export type ReauthActionResult = { error: string } | { ok: true };

// 5 wrong passwords in a minute lock the step-up for that user until the
// window slides (in-memory, per instance — see attempt-limiter.ts).
const limiter = new AttemptLimiter(5, 60_000);

// Better Auth's own cap (emailAndPassword.maxPasswordLength, default 128):
// anything longer is never a valid password and would only cost a hash.
const MAX_PASSWORD_LENGTH = 128;

/**
 * Password re-entry for step-up (review finding S4). Verifies the password
 * of the signed-in user against their credential account and, when it
 * matches, records a fresh authentication for this session and host
 * (services/auth/step-up.ts). No new session is created. The passkey
 * alternative runs through the plugin's assertion endpoint and the
 * after-hook in better-auth.ts.
 */
export async function reauthWithPasswordAction(input: {
  password: string;
}): Promise<ReauthActionResult> {
  const t = await getTranslations("auth.errors");
  const session = await getCurrentSession();
  if (!session) return { error: t("sessionExpired") };
  const userId = session.user.id;

  const password = typeof input?.password === "string" ? input.password : "";
  if (password === "" || password.length > MAX_PASSWORD_LENGTH) {
    return { error: t("incorrectPassword") };
  }
  if (!limiter.allowed(userId)) return { error: t("tooManyAttempts") };

  const ctx = await auth.$context;
  const credential = (await ctx.internalAdapter.findAccounts(userId)).find(
    (a) => a.providerId === "credential" && typeof a.password === "string" && a.password,
  );
  if (!credential?.password) return { error: t("noPassword") };

  const ok = await ctx.password.verify({ hash: credential.password, password });
  if (!ok) {
    limiter.fail(userId);
    return { error: t("incorrectPassword") };
  }
  limiter.reset(userId);

  await issueRecentAuthProof({
    userId,
    sessionToken: session.session.token,
    method: "password",
  });
  return { ok: true };
}
