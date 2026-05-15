// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Fingerprint } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signIn } from "@/services/auth/client";
import { loginAction } from "../actions";
import { LoginSchema, type LoginInput } from "../schemas";

export function LoginForm() {
  const t = useTranslations("auth.login");
  const tCommon = useTranslations("common");
  // Schemas emit translation keys as error messages — use this raw `t` so we
  // can resolve any key, then format the result.
  const tRoot = useTranslations();

  // Where to send the user after a successful login. Better Auth's session
  // cookie is apex-scoped, so a `window.location.href = returnTo` carries it
  // along — no handoff needed.
  const searchParams = useSearchParams();
  const returnTo = searchParams.get("return_to") ?? undefined;

  const [pwPending, startPwTransition] = useTransition();
  const [pkPending, startPkTransition] = useTransition();
  const [pkError, setPkError] = useState<string | null>(null);

  const form = useForm<LoginInput>({
    resolver: zodResolver(LoginSchema),
    defaultValues: { email: "", password: "" },
  });

  const onPasswordSubmit = (data: LoginInput) =>
    startPwTransition(async () => {
      const result = await loginAction(data, returnTo);
      if (result && "error" in result) {
        form.setError("root", { message: result.error });
      }
    });

  const onPasskeySignIn = () => {
    setPkError(null);
    startPkTransition(async () => {
      // Better Auth's passkey plugin discovers credentials by RP context (no
      // email needed) when the authenticator opts in. The browser shows the
      // platform passkey picker; on success the session cookie is written
      // by /api/auth/passkey/verify-authentication.
      const result = await signIn.passkey();
      if (result?.error) {
        setPkError(result.error.message ?? tRoot("auth.errors.signInFailed"));
        return;
      }
      // Hard-nav so the destination host loads with the freshly-set cookie.
      window.location.href = returnTo ?? "/";
    });
  };

  // The schema stores the i18n key in error.message (e.g. "auth.errors.emailInvalid").
  // tRoot accepts any key, so passing the raw message resolves it.
  const errors = form.formState.errors;
  const translateError = (msg: string | undefined) =>
    msg ? tRoot(msg as never) : null;

  const pending = pwPending || pkPending;

  return (
    <form
      onSubmit={form.handleSubmit(onPasswordSubmit)}
      className="space-y-4"
    >
      <div className="space-y-2">
        <Label htmlFor="email">{t("email")}</Label>
        <Input
          id="email"
          type="email"
          autoComplete="username webauthn"
          {...form.register("email")}
        />
        {errors.email && (
          <p className="text-sm text-destructive">
            {translateError(errors.email.message)}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="password">{t("password")}</Label>
          <Link
            href="/forgot-password"
            className="text-xs text-muted-foreground hover:text-foreground underline"
          >
            {t("forgotLink")}
          </Link>
        </div>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          {...form.register("password")}
        />
        {errors.password && (
          <p className="text-sm text-destructive">
            {translateError(errors.password.message)}
          </p>
        )}
      </div>

      {(errors.root || pkError) && (
        <Alert variant="destructive">
          <AlertDescription>
            {errors.root?.message ?? pkError}
          </AlertDescription>
        </Alert>
      )}

      <Button type="submit" className="w-full" disabled={pending}>
        {pwPending ? t("submitting") : t("submit")}
      </Button>

      <div className="relative">
        <div className="absolute inset-0 flex items-center">
          <span className="w-full border-t" />
        </div>
        <div className="relative flex justify-center text-xs uppercase">
          <span className="bg-card px-2 text-muted-foreground">
            {tCommon("or")}
          </span>
        </div>
      </div>

      <Button
        type="button"
        variant="outline"
        className="w-full"
        onClick={onPasskeySignIn}
        disabled={pending}
      >
        <Fingerprint className="size-4" />
        {pkPending ? t("passkeyWaiting") : t("passkeyButton")}
      </Button>
    </form>
  );
}
