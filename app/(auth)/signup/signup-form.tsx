"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signupAction } from "../actions";
import {
  PASSWORD_MIN_LENGTH,
  SignupSchema,
  type SignupInput,
} from "../schemas";

export function SignupForm() {
  const t = useTranslations("auth.signup");
  const tRoot = useTranslations();

  const [pending, startTransition] = useTransition();
  const [okMessage, setOkMessage] = useState<string | null>(null);
  const form = useForm<SignupInput>({
    resolver: zodResolver(SignupSchema),
    defaultValues: { email: "", password: "" },
  });

  const onSubmit = (data: SignupInput) =>
    startTransition(async () => {
      setOkMessage(null);
      const result = await signupAction(data);
      if (!result) return; // server-action redirected
      if ("error" in result) {
        form.setError("root", { message: result.error });
      } else if (result.message) {
        setOkMessage(result.message);
        form.reset();
      }
    });

  const errors = form.formState.errors;
  const translateError = (msg: string | undefined) =>
    msg
      ? tRoot(msg as never, { min: PASSWORD_MIN_LENGTH } as never)
      : null;

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email">{t("email")}</Label>
        <Input
          id="email"
          type="email"
          autoComplete="email"
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
          autoComplete="new-password"
          {...form.register("password")}
        />
        {errors.password && (
          <p className="text-sm text-destructive">
            {translateError(errors.password.message)}
          </p>
        )}
      </div>

      {errors.root && (
        <Alert variant="destructive">
          <AlertDescription>{errors.root.message}</AlertDescription>
        </Alert>
      )}

      {okMessage && (
        <Alert>
          <AlertDescription>{okMessage}</AlertDescription>
        </Alert>
      )}

      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? t("submitting") : t("submit")}
      </Button>
    </form>
  );
}
