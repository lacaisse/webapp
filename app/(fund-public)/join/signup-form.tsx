// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { Controller, useForm } from "react-hook-form";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signupMemberAction } from "@/services/member/actions";
import {
  SignupFormSchema,
  type SignupFormInput,
} from "@/services/member/schema";
import {
  OnboardingFieldInput,
  type FieldValue,
  type OnboardingFieldDef,
} from "../onboarding-field-input";

export function SignupForm({
  fields,
  referralCode,
}: {
  fields: OnboardingFieldDef[];
  referralCode: string | null;
}) {
  const t = useTranslations("members.signup");
  const tRoot = useTranslations();
  const [pending, startTransition] = useTransition();

  const form = useForm<SignupFormInput>({
    resolver: zodResolver(SignupFormSchema),
    defaultValues: {
      firstName: "",
      lastName: "",
      email: "",
      extras: Object.fromEntries(
        fields.map((f) => [f.key, defaultValueFor(f)]),
      ),
    },
  });

  const onSubmit = (data: SignupFormInput) =>
    startTransition(async () => {
      const { extras, ...builtins } = data;
      const result = await signupMemberAction({
        builtins,
        applicationData: extras,
        referralCode,
      });
      if ("error" in result) {
        if (result.field) {
          form.setError(result.field, { message: result.error });
        } else {
          form.setError("root", { message: result.error });
        }
        return;
      }
      window.location.href = result.redirectTo;
    });

  const errors = form.formState.errors;
  const translateError = (msg: string | undefined) => {
    if (!msg) return null;
    if (msg.startsWith("members.")) return tRoot(msg as never);
    return msg;
  };

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="firstName">{t("firstName")}</Label>
        <Input
          id="firstName"
          autoComplete="given-name"
          {...form.register("firstName")}
        />
        {errors.firstName && (
          <p className="text-sm text-destructive">
            {translateError(errors.firstName.message)}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="lastName">{t("lastName")}</Label>
        <Input
          id="lastName"
          autoComplete="family-name"
          {...form.register("lastName")}
        />
        {errors.lastName && (
          <p className="text-sm text-destructive">
            {translateError(errors.lastName.message)}
          </p>
        )}
      </div>

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

      {fields.map((field) => (
        <Controller
          key={field.id}
          control={form.control}
          name={`extras.${field.key}` as `extras.${string}`}
          render={({ field: rhfField, fieldState }) => (
            <OnboardingFieldInput
              field={field}
              value={rhfField.value as FieldValue | undefined}
              onChange={rhfField.onChange}
              error={translateError(fieldState.error?.message) ?? undefined}
            />
          )}
        />
      ))}

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

function defaultValueFor(field: OnboardingFieldDef): FieldValue {
  if (field.type === "MULTISELECT") return [];
  if (field.type === "CHECKBOX") return false;
  return "";
}
