"use server";

import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/services/auth/server";
import {
  LoginSchema,
  SignupSchema,
  type LoginInput,
  type SignupInput,
} from "./schemas";

export type ActionResult = { error: string } | { ok: true; message?: string };

export async function loginAction(input: LoginInput): Promise<ActionResult> {
  const t = await getTranslations("auth.errors");
  const parsed = LoginSchema.safeParse(input);
  if (!parsed.success) {
    return { error: t("invalidCredentials") };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) return { error: error.message };

  redirect("/");
}

export async function signupAction(input: SignupInput): Promise<ActionResult> {
  const t = await getTranslations("auth");
  const parsed = SignupSchema.safeParse(input);
  if (!parsed.success) {
    return { error: t("errors.invalidInput") };
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signUp(parsed.data);
  if (error) return { error: error.message };

  if (!data.session) {
    return { ok: true, message: t("signup.verifyEmail") };
  }
  redirect("/");
}

export async function logoutAction(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/login");
}
