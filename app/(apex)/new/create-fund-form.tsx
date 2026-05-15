// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useEffect, useTransition } from "react";
import { useForm, useWatch } from "react-hook-form";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createFundAction } from "@/services/fund/actions";
import { FUND_APEX } from "@/services/fund/host";
import {
  CreateFundSchema,
  NAME_MIN_LENGTH,
  SUBDOMAIN_MAX_LENGTH,
  SUBDOMAIN_MIN_LENGTH,
  type CreateFundInput,
} from "@/services/fund/schema";

function toSubdomain(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SUBDOMAIN_MAX_LENGTH);
}

export function CreateFundForm() {
  const t = useTranslations("funds.create");
  const tRoot = useTranslations();

  const [pending, startTransition] = useTransition();
  const form = useForm<CreateFundInput>({
    resolver: zodResolver(CreateFundSchema),
    defaultValues: { name: "", subdomain: "" },
  });

  // Auto-derive subdomain from name until the user edits the field.
  const name = useWatch({ control: form.control, name: "name" });
  const dirty = form.formState.dirtyFields.subdomain;
  useEffect(() => {
    if (!dirty) {
      form.setValue("subdomain", toSubdomain(name), {
        shouldValidate: false,
        shouldDirty: false,
      });
    }
  }, [name, dirty, form]);

  const onSubmit = (data: CreateFundInput) =>
    startTransition(async () => {
      const result = await createFundAction(data);
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
    if (msg.startsWith("funds.") || msg.startsWith("auth.")) {
      return tRoot(msg as never, {
        min: SUBDOMAIN_MIN_LENGTH,
        max: SUBDOMAIN_MAX_LENGTH,
      } as never);
    }
    return msg;
  };

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="name">{t("name")}</Label>
        <Input id="name" autoComplete="off" {...form.register("name")} />
        {errors.name && (
          <p className="text-sm text-destructive">
            {errors.name.message?.startsWith("funds.")
              ? tRoot(errors.name.message as never, {
                  min: NAME_MIN_LENGTH,
                } as never)
              : errors.name.message}
          </p>
        )}
      </div>

      <div className="space-y-2">
        <Label htmlFor="subdomain">{t("subdomain")}</Label>
        <div className="flex items-center gap-2">
          <Input
            id="subdomain"
            autoComplete="off"
            spellCheck={false}
            {...form.register("subdomain")}
          />
          <span className="text-sm text-muted-foreground whitespace-nowrap">
            .{FUND_APEX}
          </span>
        </div>
        {errors.subdomain && (
          <p className="text-sm text-destructive">
            {translateError(errors.subdomain.message)}
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
