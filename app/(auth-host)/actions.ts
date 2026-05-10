"use server";

import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/services/auth/server";
import { buildLoginRedirect } from "@/services/auth/post-login";
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

export async function loginAction(
  input: LoginInput,
  returnTo?: string,
): Promise<ActionResult> {
  const t = await getTranslations("auth.errors");
  const parsed = LoginSchema.safeParse(input);
  if (!parsed.success) {
    return { error: t("invalidCredentials") };
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) return { error: error.message };
  if (!data.user?.email) return { error: t("signInFailed") };

  const { url } = await buildLoginRedirect({
    userId: data.user.id,
    email: data.user.email,
    returnTo,
  });
  redirect(url);
}

export async function signupAction(
  input: SignupInput,
  returnTo?: string,
): Promise<ActionResult> {
  const t = await getTranslations("auth");
  const parsed = SignupSchema.safeParse(input);
  if (!parsed.success) {
    return { error: t("errors.invalidInput") };
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signUp({
    ...parsed.data,
    options: {
      // Email-verify links land on the auth host's PKCE callback. After
      // exchange, the user is forwarded to /login which (if they're already
      // signed in) bounces onward via the cross-host handoff.
      emailRedirectTo: getAuthUrl("/auth/callback?next=/login"),
    },
  });
  if (error) return { error: error.message };

  if (!data.session || !data.user?.email) {
    return { ok: true, message: t("signup.verifyEmail") };
  }

  const { url } = await buildLoginRedirect({
    userId: data.user.id,
    email: data.user.email,
    returnTo,
  });
  redirect(url);
}

export async function forgotPasswordAction(
  input: ForgotPasswordInput,
): Promise<ActionResult> {
  const t = await getTranslations("auth");
  const parsed = ForgotPasswordSchema.safeParse(input);
  if (!parsed.success) {
    return { error: t("errors.emailInvalid") };
  }

  const supabase = await createSupabaseServerClient();
  // Recovery flow lives on the auth host: Supabase emails a link with a PKCE
  // code that lands on /auth/callback (auth host), which exchanges into a
  // session, then forwards to /reset-password.
  const redirectTo = getAuthUrl(
    "/auth/callback?next=" + encodeURIComponent("/reset-password"),
  );
  const { error } = await supabase.auth.resetPasswordForEmail(
    parsed.data.email,
    { redirectTo },
  );

  // Whether or not the email matches a real account, return success — leaking
  // "this email exists" is a known account-enumeration footgun.
  if (error) {
    console.error("resetPasswordForEmail error:", error.message);
  }
  return { ok: true, message: t("forgotPassword.checkEmail") };
}

export async function resetPasswordAction(
  input: ResetPasswordInput,
): Promise<ActionResult> {
  const t = await getTranslations("auth");
  const parsed = ResetPasswordSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { error: t(issue.message as never, { min: 8 } as never) };
  }

  const supabase = await createSupabaseServerClient();
  // updateUser({ password }) requires an active session — which we have here
  // because the PKCE callback exchanged the recovery code into a real session
  // before redirecting the user to the reset form.
  const { data, error } = await supabase.auth.updateUser({
    password: parsed.data.password,
  });
  if (error) return { error: error.message };

  // Hand the freshly-recovered user off to the apex.
  if (data.user?.email) {
    const { url } = await buildLoginRedirect({
      userId: data.user.id,
      email: data.user.email,
    });
    redirect(url);
  }
  redirect("/");
}
