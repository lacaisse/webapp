// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { APIError } from "better-auth/api";
import { headers } from "next/headers";
import { getTranslations } from "next-intl/server";
import { auth } from "@/services/auth/better-auth";
import { requireUser } from "@/services/auth/dal";
import { ChangePasswordSchema, type ChangePasswordInput } from "./schema";

export type ActionResult = { error: string } | { ok: true };

// Change the signed-in user's password. Better Auth's `changePassword`
// re-checks `currentPassword` itself, so a wrong current password comes back
// as an APIError — we don't pre-verify. `revokeOtherSessions: true` signs the
// user out everywhere else (other devices / fund subdomains) as a standard
// security measure when the password changes; the current session's cookie is
// refreshed by the nextCookies() plugin on this Server Action response.
export async function changePasswordAction(
  input: ChangePasswordInput,
): Promise<ActionResult> {
  await requireUser();
  const t = await getTranslations("auth.errors");

  const parsed = ChangePasswordSchema.safeParse(input);
  if (!parsed.success) {
    return { error: t("invalidInput") };
  }

  try {
    await auth.api.changePassword({
      body: {
        currentPassword: parsed.data.currentPassword,
        newPassword: parsed.data.newPassword,
        revokeOtherSessions: true,
      },
      headers: await headers(),
    });
  } catch (e) {
    // Most likely cause is a wrong current password; Better Auth surfaces it
    // as an APIError. Treat all APIErrors as "incorrect password" rather than
    // leaking internal detail.
    if (e instanceof APIError) return { error: t("incorrectPassword") };
    throw e;
  }

  return { ok: true };
}
