"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useTransition } from "react";
import { useForm } from "react-hook-form";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signupMemberAction } from "@/services/member/actions";
import {
  SignupFormSchema,
  type SignupFormInput,
} from "@/services/member/schema";

type FieldType =
  | "TEXT"
  | "TEXTAREA"
  | "EMAIL"
  | "PHONE"
  | "NUMBER"
  | "SELECT"
  | "MULTISELECT"
  | "CHECKBOX"
  | "DATE";

type OnboardingFieldProps = {
  id: string;
  key: string;
  type: FieldType;
  label: string;
  helpText: string | null;
  required: boolean;
};

export function SignupForm({
  fields,
  referralCode,
}: {
  fields: OnboardingFieldProps[];
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
      extras: Object.fromEntries(fields.map((f) => [f.key, ""])),
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
        <div key={field.id} className="space-y-2">
          <Label htmlFor={field.id}>
            {field.label}
            {field.required && (
              <span className="ml-1 text-destructive" aria-hidden>
                *
              </span>
            )}
          </Label>
          <Input
            id={field.id}
            type={inputTypeFor(field.type)}
            required={field.required}
            {...form.register(`extras.${field.key}` as `extras.${string}`)}
          />
          {field.helpText && (
            <p className="text-xs text-muted-foreground">{field.helpText}</p>
          )}
        </div>
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

// HTML5 input type for an OnboardingField. Types without a native HTML
// counterpart (TEXTAREA, SELECT, MULTISELECT, CHECKBOX) fall back to a
// plain text input — proper rendering lands when we have the matching
// shadcn-base-nova primitives wired up.
function inputTypeFor(fieldType: FieldType): string {
  switch (fieldType) {
    case "EMAIL":
      return "email";
    case "PHONE":
      return "tel";
    case "NUMBER":
      return "number";
    case "DATE":
      return "date";
    default:
      return "text";
  }
}
