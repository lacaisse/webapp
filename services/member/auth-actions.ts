// SPDX-License-Identifier: AGPL-3.0-or-later
"use server";

import { isAPIError } from "better-auth/api";
import { headers } from "next/headers";
import { getLocale, getTranslations } from "next-intl/server";

import { AttemptLimiter } from "@/services/auth/attempt-limiter";
import { auth } from "@/services/auth/better-auth";
import { requireMember } from "@/services/auth/dal";
import { requireCurrentFund } from "@/services/fund/server";
import { getFundUrl } from "@/services/fund/host";

import {
  removeMemberLogin,
  resendMemberVerification,
  signUpMember,
} from "./auth";
import {
  MemberForgotSchema,
  MemberLoginSchema,
  MemberResetSchema,
  MemberSignupInputSchema,
  type MemberForgotInput,
  type MemberLoginInput,
  type MemberResetInput,
} from "./auth-schema";
import type { SignupMemberResult } from "./actions";

// Server actions behind the member pages (app/(fund-member), reached as
// /login, /signup, /forgot, /reset, /account on an opted-in fund host). All
// of them run on the fund host: the session cookie Better Auth writes is
// that host's own (nextCookies on the action response), exactly like the
// staff flow after /auth/exchange. The logic lives in services/member/auth.ts.
//
// Rate limits: server actions bypass Better Auth's endpoint limiter, so the
// public ones carry a per-IP AttemptLimiter (in-memory, per instance —
// best-effort, same as the step-up password check).
//
// Navigation: the actions answer `redirectTo` and the forms do a FULL
// navigation (`window.location.assign`), never `redirect()`. A server-action
// redirect is rendered inside the action response and skips proxy.ts, so
// `/account` would resolve to the apex account route instead of the member
// page the proxy rewrites it to (see MEMBER_PAGE_SEGMENTS in proxy.ts).

export type MemberAuthResult =
  | { error: string }
  | { ok: true; message?: string; redirectTo?: string };

// 5 sign-ups per IP per hour; 10 failed logins per IP per 10 minutes; 5
// reset emails per IP per hour.
const signupLimiter = new AttemptLimiter(5, 60 * 60_000);
const loginLimiter = new AttemptLimiter(10, 10 * 60_000);
const forgotLimiter = new AttemptLimiter(5, 60 * 60_000);

async function clientIp(): Promise<string> {
  const h = await headers();
  const forwarded = h.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || h.get("x-real-ip") || "unknown";
}

// Only same-host paths come back from `return_to`; anything else lands on
// the account page.
function safeReturnPath(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/account";
  return raw;
}

export async function signUpMemberAction(input: unknown): Promise<SignupMemberResult> {
  const t = await getTranslations();
  const fund = await requireCurrentFund();
  if (!fund.memberLoginEnabled) return { error: t("memberLogin.errors.disabled") };

  const parsed = MemberSignupInputSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue.path[issue.path.length - 1];
    return {
      error: t(issue.message as never, { min: 8 } as never),
      field:
        field === "firstName" || field === "lastName" || field === "email"
          ? field
          : undefined,
    };
  }

  const ip = await clientIp();
  if (!signupLimiter.allowed(ip)) return { error: t("memberLogin.errors.tooMany") };
  signupLimiter.fail(ip);

  const result = await signUpMember(
    fund,
    { ...parsed.data, locale: await getLocale() },
    (key, values) => t(key as never, values as never),
  );
  if (!result.ok) {
    switch (result.error) {
      case "invalid":
        return result.field
          ? { error: result.message ?? t("memberLogin.errors.generic"), field: result.field }
          : { error: result.message ?? t("memberLogin.errors.generic") };
      case "account_exists":
        return { error: t("memberLogin.errors.accountExists"), field: "email" };
      case "membership_has_login":
        return { error: t("memberLogin.errors.membershipHasLogin"), field: "email" };
      case "disabled":
        return { error: t("memberLogin.errors.disabled") };
      default:
        return { error: t("memberLogin.errors.generic") };
    }
  }
  return { ok: true, redirectTo: "/login?notice=check_email" };
}

export async function memberLoginAction(
  input: MemberLoginInput,
  returnTo?: string | null,
): Promise<MemberAuthResult> {
  const t = await getTranslations("memberLogin");
  const fund = await requireCurrentFund();
  if (!fund.memberLoginEnabled) return { error: t("errors.disabled") };

  const parsed = MemberLoginSchema.safeParse(input);
  if (!parsed.success) return { error: t("errors.invalidCredentials") };

  const key = `${await clientIp()}:${parsed.data.email.toLowerCase()}`;
  if (!loginLimiter.allowed(key)) return { error: t("errors.tooMany") };

  try {
    // nextCookies() writes this host's session cookie on the action response.
    await auth.api.signInEmail({
      body: { email: parsed.data.email, password: parsed.data.password },
      headers: await headers(),
    });
  } catch (e) {
    if (!isAPIError(e)) throw e;
    loginLimiter.fail(key);
    return { error: t("errors.invalidCredentials") };
  }
  loginLimiter.reset(key);
  return { ok: true, redirectTo: safeReturnPath(returnTo) };
}

export async function memberForgotPasswordAction(
  input: MemberForgotInput,
): Promise<MemberAuthResult> {
  const t = await getTranslations("memberLogin");
  const fund = await requireCurrentFund();
  if (!fund.memberLoginEnabled) return { error: t("errors.disabled") };

  const parsed = MemberForgotSchema.safeParse(input);
  if (!parsed.success) return { error: t("errors.emailInvalid") };

  const ip = await clientIp();
  if (!forgotLimiter.allowed(ip)) return { error: t("errors.tooMany") };
  forgotLimiter.fail(ip);

  try {
    // The link comes back to THIS fund host's /reset (a member page), not
    // the staff reset page on the auth host.
    await auth.api.requestPasswordReset({
      body: {
        email: parsed.data.email,
        redirectTo: `${getFundUrl(fund.domain)}/reset`,
      },
      headers: await headers(),
    });
  } catch (e) {
    // Same answer whether or not the address exists; log for ops.
    if (isAPIError(e)) console.error("[member-login] requestPasswordReset error:", e.body);
    else throw e;
  }
  return { ok: true, message: t("forgot.checkEmail") };
}

export async function memberResetPasswordAction(
  input: MemberResetInput,
  token: string,
): Promise<MemberAuthResult> {
  const t = await getTranslations();
  const fund = await requireCurrentFund();
  if (!fund.memberLoginEnabled) return { error: t("memberLogin.errors.disabled") };

  const parsed = MemberResetSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { error: t(issue.message as never, { min: 8 } as never) };
  }
  if (!token) return { error: t("memberLogin.errors.resetExpired") };

  try {
    await auth.api.resetPassword({
      body: { newPassword: parsed.data.password, token },
      headers: await headers(),
    });
  } catch (e) {
    if (isAPIError(e)) return { error: t("memberLogin.errors.resetExpired") };
    throw e;
  }
  // The reset revoked every session (revokeSessionsOnPasswordReset) — sign
  // in again with the new password.
  return { ok: true, redirectTo: "/login?notice=password_reset" };
}

export async function resendMemberVerificationAction(): Promise<MemberAuthResult> {
  const t = await getTranslations();
  const { user, fund, member } = await requireMember();
  if (member.emailVerifiedAt && user.emailVerified) {
    return { ok: true, message: t("memberLogin.account.verification.alreadyVerified") };
  }
  const ip = await clientIp();
  if (!forgotLimiter.allowed(ip)) return { error: t("memberLogin.errors.tooMany") };
  forgotLimiter.fail(ip);
  await resendMemberVerification(fund, member, user, (key, values) =>
    t(key as never, values as never),
  );
  return { ok: true, message: t("memberLogin.account.verification.sent") };
}

export async function removeMemberLoginAction(): Promise<MemberAuthResult> {
  const { user, member } = await requireMember();
  const { userDeleted } = await removeMemberLogin({ memberId: member.id, userId: user.id });
  // Sign this host out (and every other session when the user is gone —
  // its rows cascaded). A surviving staff/other-fund user keeps their other
  // sessions; only this host's cookie is cleared.
  try {
    await auth.api.signOut({ headers: await headers() });
  } catch {
    // already signed out
  }
  return {
    ok: true,
    redirectTo: userDeleted ? "/login?notice=login_removed" : "/login?notice=unlinked",
  };
}
