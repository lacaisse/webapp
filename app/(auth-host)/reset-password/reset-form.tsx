"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { useForm } from "react-hook-form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { resetPasswordAction } from "../actions";
import {
  PASSWORD_MIN_LENGTH,
  ResetPasswordSchema,
  type ResetPasswordInput,
} from "../schemas";

export function ResetPasswordForm({ token }: { token: string }) {
  const t = useTranslations("auth.resetPassword");
  const tRoot = useTranslations();

  const [pending, startTransition] = useTransition();
  const form = useForm<ResetPasswordInput>({
    resolver: zodResolver(ResetPasswordSchema),
    defaultValues: { password: "", confirmPassword: "" },
  });

  const onSubmit = (data: ResetPasswordInput) =>
    startTransition(async () => {
      const result = await resetPasswordAction(data, token);
      if (result && "error" in result) {
        form.setError("root", { message: result.error });
      }
    });

  const errors = form.formState.errors;
  const translateError = (msg: string | undefined) =>
    msg ? tRoot(msg as never, { min: PASSWORD_MIN_LENGTH } as never) : null;

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
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

      <div className="space-y-2">
        <Label htmlFor="confirmPassword">{t("confirmPassword")}</Label>
        <Input
          id="confirmPassword"
          type="password"
          autoComplete="new-password"
          {...form.register("confirmPassword")}
        />
        {errors.confirmPassword && (
          <p className="text-sm text-destructive">
            {translateError(errors.confirmPassword.message)}
          </p>
        )}
      </div>

      {errors.root && (
        <Alert variant="destructive">
          <AlertDescription>{errors.root.message}</AlertDescription>
        </Alert>
      )}

      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? t("submitting") : t("submit")}
      </Button>
    </form>
  );
}
