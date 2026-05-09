"use client";

import { startAuthentication } from "@simplewebauthn/browser";
import { zodResolver } from "@hookform/resolvers/zod";
import { Fingerprint } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { loginAction } from "../actions";
import { LoginSchema, type LoginInput } from "../schemas";

export function LoginForm() {
  const t = useTranslations("auth.login");
  const tCommon = useTranslations("common");
  // Schemas emit translation keys as error messages — use this raw `t` so we
  // can resolve any key, then format the result.
  const tRoot = useTranslations();

  const [pwPending, startPwTransition] = useTransition();
  const [pkPending, startPkTransition] = useTransition();
  const [pkError, setPkError] = useState<string | null>(null);

  const form = useForm<LoginInput>({
    resolver: zodResolver(LoginSchema),
    defaultValues: { email: "", password: "" },
  });

  const onPasswordSubmit = (data: LoginInput) =>
    startPwTransition(async () => {
      const result = await loginAction(data);
      if (result && "error" in result) {
        form.setError("root", { message: result.error });
      }
    });

  const onPasskeySignIn = () => {
    setPkError(null);
    const email = form.getValues("email");
    if (!email) {
      form.setError("email", { message: "auth.login.passkeyEmailRequired" });
      return;
    }

    startPkTransition(async () => {
      try {
        const optionsRes = await fetch(
          "/api/webauthn/authenticate/options",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ email }),
          },
        );
        if (!optionsRes.ok) {
          throw new Error(tRoot("auth.errors.passkeyStartFailed"));
        }
        const options = await optionsRes.json();

        const assertion = await startAuthentication({ optionsJSON: options });

        const verifyRes = await fetch(
          "/api/webauthn/authenticate/verify",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ response: assertion }),
          },
        );
        const verifyJson = await verifyRes.json();
        if (!verifyRes.ok) {
          throw new Error(verifyJson.error ?? tRoot("auth.errors.signInFailed"));
        }

        // Server set the Supabase session cookie. Force a full nav so the
        // proxy + DAL pick up the new session for SSR.
        window.location.href = "/";
      } catch (e) {
        setPkError(
          e instanceof Error ? e.message : tRoot("auth.errors.signInFailed"),
        );
      }
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
        <Label htmlFor="password">{t("password")}</Label>
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
