// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { useForm } from "react-hook-form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { changePasswordAction } from "./actions";
import {
  ChangePasswordSchema,
  PASSWORD_MIN_LENGTH,
  type ChangePasswordInput,
} from "./schema";

export function ChangePasswordCard() {
  const t = useTranslations("account.security");
  const tRoot = useTranslations();

  const [pending, startTransition] = useTransition();
  const [okMessage, setOkMessage] = useState<string | null>(null);
  const form = useForm<ChangePasswordInput>({
    resolver: zodResolver(ChangePasswordSchema),
    defaultValues: {
      currentPassword: "",
      newPassword: "",
      confirmPassword: "",
    },
  });

  const onSubmit = (data: ChangePasswordInput) =>
    startTransition(async () => {
      setOkMessage(null);
      const result = await changePasswordAction(data);
      if ("error" in result) {
        form.setError("root", { message: result.error });
        return;
      }
      setOkMessage(t("success"));
      form.reset();
    });

  const errors = form.formState.errors;
  const translateError = (msg: string | undefined) =>
    msg ? tRoot(msg as never, { min: PASSWORD_MIN_LENGTH } as never) : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("passwordTitle")}</CardTitle>
        <CardDescription>{t("passwordDescription")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="currentPassword">{t("currentPassword")}</Label>
            <Input
              id="currentPassword"
              type="password"
              autoComplete="current-password"
              {...form.register("currentPassword")}
            />
            {errors.currentPassword && (
              <p className="text-sm text-destructive">
                {translateError(errors.currentPassword.message)}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="newPassword">{t("newPassword")}</Label>
            <Input
              id="newPassword"
              type="password"
              autoComplete="new-password"
              {...form.register("newPassword")}
            />
            {errors.newPassword && (
              <p className="text-sm text-destructive">
                {translateError(errors.newPassword.message)}
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

          {okMessage && (
            <Alert>
              <AlertDescription>{okMessage}</AlertDescription>
            </Alert>
          )}

          <Button type="submit" disabled={pending}>
            {pending ? t("submitting") : t("submit")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
