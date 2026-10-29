// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { isAPIError } from "better-auth/api";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { auth } from "@/services/auth/better-auth";
import { oauthRedirectFrom } from "@/services/auth/oauth-query";
import {
  oauthRedirectFromError,
  oauthResumeCallContext,
} from "@/services/auth/oauth-resume";
import { buildPostAuthRedirect } from "@/services/auth/redirects";
import { createInvitedAccount } from "@/services/auth/signup";
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

// `redirectTo`: a URL the form must navigate to itself (full navigation) —
// the next hop of an MCP OAuth flow, see services/auth/oauth-resume.ts.
export type ActionResult =
  | { error: string }
  | { ok: true; message?: string; redirectTo?: string };

// MCP OAuth resume: when a sign-in happens mid-OAuth-authorization (the MCP
// plugin sent the user to /login with a signed copy of the authorize query),
// the login form hands that query back here as `oauthQuery`. Passed as
// `oauth_query` in the sign-in body, the plugin verifies it and finishes the
// authorization inside the sign-in call: the result is the next hop
// (consent page, or the client's redirect_uri with the code) — see
// services/auth/oauth-resume.ts for the two shapes it comes in. In that case
// we do NOT run the cross-host handoff: the user stays on the auth host,
// whose fresh session cookie is what the consent page needs.

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
  oauthQuery?: string,
): Promise<ActionResult> {
  const t = await getTranslations("auth.errors");
  const parsed = LoginSchema.safeParse(input);
  if (!parsed.success) {
    return { error: t("invalidCredentials") };
  }

  let result: { user: { id: string; email: string } };
  try {
    // `oauth_query` isn't part of signInEmail's declared body — the OAuth
    // provider plugin reads it from the raw body in a before-hook.
    const body = {
      email: parsed.data.email,
      password: parsed.data.password,
      ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
    } as { email: string; password: string };
    const signedIn: unknown = await auth.api.signInEmail({
      body,
      ...(oauthQuery
        ? await oauthResumeCallContext("/sign-in/email")
        : { headers: await headers() }),
    });
    // Only mid-OAuth: a plain sign-in response carries `redirect`/`url`
    // fields of its own (callbackURL) that must never bypass the exchange.
    if (oauthQuery) {
      const next = await oauthRedirectFrom(signedIn);
      if (next) return { ok: true, redirectTo: next };
    }
    result = signedIn as typeof result;
  } catch (e) {
    // Better Auth surfaces auth failures as APIError. Treat them all as
    // "invalid credentials" to avoid leaking which field was wrong — except
    // the MCP OAuth resume redirect, which rides in as APIError("FOUND"),
    // and a stale signed query (10 min), which is the agent's fault, not
    // the password's.
    if (isAPIError(e)) {
      const next = oauthRedirectFromError(e);
      if (next) return { ok: true, redirectTo: next };
      if (
        oauthQuery &&
        (e.body as { error?: string } | undefined)?.error === "invalid_signature"
      ) {
        return { error: (await getTranslations("auth.consent"))("invalid") };
      }
      return { error: t("invalidCredentials") };
    }
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
  returnTo?: string,
): Promise<ActionResult> {
  const t = await getTranslations("auth");

  // Self-serve signups are closed (waitlist-only). An account is created
  // only for the address of a live staff invite whose token the visitor
  // holds: the invite accept URL rides in as `returnTo` (the public signup
  // route renders the form only with one). Better Auth's own sign-up
  // endpoint is disabled, so this action is the single door.
  const parsed = SignupSchema.safeParse(input);
  if (!parsed.success) {
    return { error: t("errors.invalidInput") };
  }

  const created = await createInvitedAccount({
    email: parsed.data.email,
    password: parsed.data.password,
    returnTo,
  });
  if ("error" in created) {
    if (created.error === "email_mismatch") return { error: t("errors.signupEmailMismatch") };
    if (created.error === "exists") return { error: t("errors.accountExists") };
    return { error: t("errors.signupsClosed") };
  }

  // Sign the new account in on this host the same way the login form does
  // (nextCookies writes the session cookie on this action's response), then
  // hand it to the invite page through the cross-host exchange —
  // `buildPostAuthRedirect` validates the target host and falls back to the
  // apex if it's not allowed. The invite accept page doesn't bounce off
  // requireFundRole, so a fresh signup is safe there.
  try {
    await auth.api.signInEmail({
      body: { email: created.user.email, password: parsed.data.password },
      headers: await headers(),
    });
  } catch (e) {
    if (!isAPIError(e)) throw e;
    console.error("[auth] sign-in after invited sign-up failed:", e.body);
    return { error: t("errors.signInFailed") };
  }

  redirect(
    await buildPostAuthRedirect({
      userId: created.user.id,
      email: created.user.email,
      returnTo: returnTo || getApexUrl("/?welcome=passkey"),
    }),
  );
}

// MCP OAuth consent (the plugin's `consentPage`, app/(auth-host)/consent).
// `oauthQuery` is the signed query the consent page was opened with; the
// plugin needs it back to know which authorize request is being decided.
// Accepting stores the OauthConsent row and answers with the client's
// redirect_uri carrying the authorization code; declining answers with the
// redirect_uri carrying `error=access_denied`. Either way the form sends
// the browser there (`redirectTo`).
export async function consentAction(
  accept: boolean,
  oauthQuery: string,
): Promise<ActionResult> {
  const t = await getTranslations("auth.consent");
  try {
    const result: unknown = await auth.api.oauth2Consent({
      body: { accept, oauth_query: oauthQuery },
      ...(await oauthResumeCallContext("/oauth2/consent")),
    });
    const next = await oauthRedirectFrom(result);
    if (next) return { ok: true, redirectTo: next };
  } catch (e) {
    if (isAPIError(e)) {
      const next = oauthRedirectFromError(e);
      if (next) return { ok: true, redirectTo: next };
      return { error: t("invalid") };
    }
    throw e;
  }
  return { error: t("invalid") };
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
    if (isAPIError(e)) {
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
    if (isAPIError(e)) {
      return { error: e.body?.message ?? t("errors.sessionExpired") };
    }
    throw e;
  }

  // Better Auth's resetPassword consumes the token but does NOT auto-create
  // a session. Send the user to /login on the auth host so they sign in with
  // their new password.
  redirect("/login");
}
