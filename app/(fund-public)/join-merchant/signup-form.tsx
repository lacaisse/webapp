// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  signupMerchantAction,
  type SignupMerchantField,
} from "@/services/merchant/actions";
import {
  MerchantSignupFormSchema,
  type MerchantSignupFormInput,
} from "@/services/merchant/schema";
import { isFieldVisible } from "@/services/onboarding/visibility";
import {
  OnboardingFieldInput,
  type FieldValue,
  type OnboardingFieldDef,
} from "../onboarding-field-input";

type BuiltinFieldName = Exclude<SignupMerchantField, never>;

type BuiltinFieldSpec = {
  name: BuiltinFieldName;
  required: boolean;
  type: "text" | "email" | "tel" | "url";
  autoComplete?: string;
};

const BUILTIN_FIELDS: BuiltinFieldSpec[] = [
  { name: "name", required: true, type: "text", autoComplete: "organization" },
  { name: "description", required: false, type: "text" },
  { name: "contactName", required: true, type: "text", autoComplete: "name" },
  { name: "email", required: true, type: "email", autoComplete: "email" },
  { name: "phone", required: false, type: "tel", autoComplete: "tel" },
  { name: "website", required: false, type: "url", autoComplete: "url" },
  { name: "logoUrl", required: false, type: "url" },
  { name: "address", required: true, type: "text", autoComplete: "street-address" },
  { name: "postalCode", required: true, type: "text", autoComplete: "postal-code" },
  { name: "city", required: true, type: "text", autoComplete: "address-level2" },
  { name: "country", required: true, type: "text", autoComplete: "country-name" },
];

export function MerchantSignupForm({
  fields,
}: {
  fields: OnboardingFieldDef[];
}) {
  const t = useTranslations("merchants.signup");
  const tFields = useTranslations("merchants.signup.fields");
  const tRoot = useTranslations();
  const [pending, startTransition] = useTransition();

  const form = useForm<MerchantSignupFormInput>({
    resolver: zodResolver(MerchantSignupFormSchema),
    defaultValues: {
      name: "",
      description: "",
      contactName: "",
      email: "",
      phone: "",
      website: "",
      logoUrl: "",
      address: "",
      postalCode: "",
      city: "",
      country: "",
      extras: Object.fromEntries(
        fields.map((f) => [f.key, defaultValueFor(f)]),
      ),
    },
  });

  const onSubmit = (data: MerchantSignupFormInput) =>
    startTransition(async () => {
      const { extras, ...builtins } = data;
      const result = await signupMerchantAction({
        builtins,
        applicationData: extras,
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
    if (msg.startsWith("merchants.")) return tRoot(msg as never);
    return msg;
  };

  // See the matching comment in app/(fund-public)/join/signup-form.tsx —
  // UX only, signupMerchantAction re-checks visibility server-side.
  const extrasValues = (useWatch({ control: form.control, name: "extras" }) ??
    {}) as Record<string, unknown>;
  const visibleFields = fields.filter((field) =>
    isFieldVisible(field.visibleIf, extrasValues),
  );

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
      {BUILTIN_FIELDS.map((spec) => {
        const fieldError = errors[spec.name];
        return (
          <div key={spec.name} className="space-y-2">
            <Label htmlFor={spec.name}>
              {tFields(spec.name)}
              {spec.required && (
                <span className="ml-1 text-destructive" aria-hidden>
                  *
                </span>
              )}
            </Label>
            <Input
              id={spec.name}
              type={spec.type}
              autoComplete={spec.autoComplete}
              {...form.register(spec.name)}
            />
            {fieldError && (
              <p className="text-sm text-destructive">
                {translateError(fieldError.message)}
              </p>
            )}
          </div>
        );
      })}

      {visibleFields.map((field) => (
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
