// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { useForm } from "react-hook-form";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { memberForgotPasswordAction } from "@/services/member/auth-actions";
import { MemberForgotSchema, type MemberForgotInput } from "@/services/member/auth-schema";

export function MemberForgotForm() {
  const t = useTranslations("memberLogin.forgot");
  const tRoot = useTranslations();
  const [pending, startTransition] = useTransition();
  const [okMessage, setOkMessage] = useState<string | null>(null);
  const form = useForm<MemberForgotInput>({
    resolver: zodResolver(MemberForgotSchema),
    defaultValues: { email: "" },
  });

  const onSubmit = (data: MemberForgotInput) =>
    startTransition(async () => {
      setOkMessage(null);
      const result = await memberForgotPasswordAction(data);
      if ("error" in result) form.setError("root", { message: result.error });
      else if (result.message) {
        setOkMessage(result.message);
        form.reset();
      }
    });

  const errors = form.formState.errors;
  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email">{t("email")}</Label>
        <Input id="email" type="email" autoComplete="email" {...form.register("email")} />
        {errors.email && (
          <p className="text-sm text-destructive">{tRoot(errors.email.message as never)}</p>
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
