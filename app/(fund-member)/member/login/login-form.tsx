// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Fingerprint } from "lucide-react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { useState, useTransition } from "react";
import { useForm } from "react-hook-form";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signIn } from "@/services/auth/client";
import { memberLoginAction } from "@/services/member/auth-actions";
import { MemberLoginSchema, type MemberLoginInput } from "@/services/member/auth-schema";

export function MemberLoginForm({ returnTo }: { returnTo?: string }) {
  const t = useTranslations("memberLogin.login");
  const tCommon = useTranslations("common");
  const tRoot = useTranslations();

  const [pwPending, startPw] = useTransition();
  const [pkPending, startPk] = useTransition();
  const [pkError, setPkError] = useState<string | null>(null);

  const form = useForm<MemberLoginInput>({
    resolver: zodResolver(MemberLoginSchema),
    defaultValues: { email: "", password: "" },
  });

  const onPasswordSubmit = (data: MemberLoginInput) =>
    startPw(async () => {
      const result = await memberLoginAction(data, returnTo);
      if ("error" in result) {
        form.setError("root", { message: result.error });
      } else if (result.redirectTo) {
        // Full navigation: the session cookie is set and /account is a
        // proxy-rewritten member path (see services/member/auth-actions.ts).
        window.location.assign(result.redirectTo);
      }
    });

  const onPasskey = () => {
    setPkError(null);
    startPk(async () => {
      // The plugin's assertion endpoint on THIS origin writes this host's
      // session cookie; a hard navigation then loads the account with it.
      const result = await signIn.passkey();
      if (result?.error) {
        setPkError(result.error.message ?? tRoot("auth.errors.signInFailed"));
        return;
      }
      window.location.href = returnTo ?? "/account";
    });
  };

  const errors = form.formState.errors;
  const translateError = (msg: string | undefined) => (msg ? tRoot(msg as never) : null);
  const pending = pwPending || pkPending;

  return (
    <form onSubmit={form.handleSubmit(onPasswordSubmit)} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email">{t("email")}</Label>
        <Input
          id="email"
          type="email"
          autoComplete="username webauthn"
          {...form.register("email")}
        />
        {errors.email && (
          <p className="text-sm text-destructive">{translateError(errors.email.message)}</p>
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="password">{t("password")}</Label>
          <Link
            href="/forgot"
            className="text-xs text-muted-foreground underline hover:text-foreground"
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
          <p className="text-sm text-destructive">{translateError(errors.password.message)}</p>
        )}
      </div>

      {(errors.root || pkError) && (
        <Alert variant="destructive">
          <AlertDescription>{errors.root?.message ?? pkError}</AlertDescription>
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
          <span className="bg-card px-2 text-muted-foreground">{tCommon("or")}</span>
        </div>
      </div>

      <Button
        type="button"
        variant="outline"
        className="w-full"
        onClick={onPasskey}
        disabled={pending}
      >
        <Fingerprint className="size-4" />
        {pkPending ? t("passkeyWaiting") : t("passkeyButton")}
      </Button>
    </form>
  );
}
