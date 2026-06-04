// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { APIError } from "better-auth/api";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth } from "@/services/auth/better-auth";
import { buildPostAuthRedirect } from "@/services/auth/redirects";
import { getApexUrl } from "@/services/fund/server";
import { getAuthUrl } from "@/services/host/server";
import {
  ForgotPasswordSchema,
  LoginSchema,
  ResetPasswordSchema,
  SignupSchema,
  type ForgotPasswordInput,
  type LoginInput,
  type ResetPasswordInput,
  type SignupInput,
} from "./schemas";

export type ActionResult = { error: string } | { ok: true; message?: string };

// After auth on this host (`auth.<APP_DOMAIN>`), we DON'T redirect the browser
// straight to the target. Instead `buildPostAuthRedirect` mints a single-use
// `AuthExchange` code bound to (userId, targetHost) and returns a URL pointing
// at `<target>/auth/exchange?code=…`. The target host's route handler consumes
// the code and writes its own session cookie there.
//
// This is the Google-style handoff: each host owns its own cookie, no
// crossSubDomainCookies required. Works identically for free fund subdomains,
// paid custom domains, and users with 3rd-party cookies disabled.

export async function loginAction(
  input: LoginInput,
  returnTo?: string,
): Promise<ActionResult> {
  const t = await getTranslations("auth.errors");
  const parsed = LoginSchema.safeParse(input);
  if (!parsed.success) {
    return { error: t("invalidCredentials") };
  }

  let result: { user: { id: string; email: string } };
  try {
    result = await auth.api.signInEmail({
      body: {
        email: parsed.data.email,
        password: parsed.data.password,
      },
      headers: await headers(),
    });
  } catch (e) {
    // Better Auth surfaces auth failures as APIError. Treat them all as
    // "invalid credentials" to avoid leaking which field was wrong.
    if (e instanceof APIError) return { error: t("invalidCredentials") };
    throw e;
  }

  redirect(
    await buildPostAuthRedirect({
      userId: result.user.id,
      email: result.user.email,
      returnTo,
    }),
  );
}

export async function signupAction(
  input: SignupInput,
): Promise<ActionResult> {
  const t = await getTranslations("auth");
  const parsed = SignupSchema.safeParse(input);
  if (!parsed.success) {
    return { error: t("errors.invalidInput") };
  }

  let result: { user: { id: string; email: string } };
  try {
    // Better Auth's email sign-up auto-creates a session when
    // requireEmailVerification is false. The `name` field is required by
    // Better Auth's schema; we derive a stub from the email local-part and
    // let the user edit it later in account settings.
    result = await auth.api.signUpEmail({
      body: {
        email: parsed.data.email,
        password: parsed.data.password,
        name: parsed.data.email.split("@")[0] ?? "",
      },
      headers: await headers(),
    });
  } catch (e) {
    if (e instanceof APIError) {
      // Surface the localized message Better Auth returned (e.g. "user already
      // exists"). Falls back to a generic "invalid input" if absent.
      return { error: e.body?.message ?? t("errors.invalidInput") };
    }
    throw e;
  }

  // Fresh signups have no fund memberships, so we always send them to the
  // apex picker (its empty state shows a "create your first fund" CTA). No
  // return_to honoured — a fund subdomain would just bounce off
  // requireFundRole on arrival.
  //
  // `welcome=passkey` rides along through the exchange (it's preserved as the
  // return_to path) so the apex picker can offer the just-registered user a
  // one-tap passkey setup. The apex is a subdomain of rpID (= APP_DOMAIN), so
  // the WebAuthn ceremony works there.
  redirect(
    await buildPostAuthRedirect({
      userId: result.user.id,
      email: result.user.email,
      returnTo: getApexUrl("/?welcome=passkey"),
    }),
  );
}

export async function forgotPasswordAction(
  input: ForgotPasswordInput,
): Promise<ActionResult> {
  const t = await getTranslations("auth");
  const parsed = ForgotPasswordSchema.safeParse(input);
  if (!parsed.success) {
    return { error: t("errors.emailInvalid") };
  }

  try {
    await auth.api.requestPasswordReset({
      body: {
        email: parsed.data.email,
        // Better Auth appends `?token=...` to redirectTo and emails the
        // result. The reset form on this host reads the token from URL.
        redirectTo: getAuthUrl("/reset-password"),
      },
      headers: await headers(),
    });
  } catch (e) {
    // Don't leak whether the email exists — return the same success message
    // regardless. Log so we can spot SMTP/Resend breakage server-side.
    if (e instanceof APIError) {
      console.error("requestPasswordReset error:", e.body);
    } else {
      throw e;
    }
  }
  return { ok: true, message: t("forgotPassword.checkEmail") };
}

export async function resetPasswordAction(
  input: ResetPasswordInput,
  token: string,
): Promise<ActionResult> {
  const t = await getTranslations("auth");
  const parsed = ResetPasswordSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { error: t(issue.message as never, { min: 8 } as never) };
  }
  if (!token) {
    return { error: t("errors.sessionExpired") };
  }

  try {
    await auth.api.resetPassword({
      body: { newPassword: parsed.data.password, token },
      headers: await headers(),
    });
  } catch (e) {
    if (e instanceof APIError) {
      return { error: e.body?.message ?? t("errors.sessionExpired") };
    }
    throw e;
  }

  // Better Auth's resetPassword consumes the token but does NOT auto-create
  // a session. Send the user to /login on the auth host so they sign in with
  // their new password.
  redirect("/login");
}
