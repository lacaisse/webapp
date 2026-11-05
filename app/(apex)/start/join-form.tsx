// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useEffect, useState, useTransition } from "react";
import { useForm, useWatch } from "react-hook-form";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { FUND_APEX } from "@/services/fund/host";
import {
  NAME_MIN_LENGTH,
  SUBDOMAIN_MAX_LENGTH,
  SUBDOMAIN_MIN_LENGTH,
  toSubdomain,
} from "@/services/fund/schema";
import { joinWithCodeAction, type JoinField } from "@/services/fund-setup/join-actions";
import {
  JoinWithCodeSchema,
  PASSWORD_MIN_LENGTH,
  type JoinWithCodeInput,
  type JoinWithCodeValues,
} from "@/services/fund-setup/schema";

// The account + fund form behind a code that checked out (the page passes it
// formatted; it travels with the submit and is claimed there). Field errors
// come back as translation keys from the resolver and as translated text from
// the action; the {min}/{max} placeholders differ per field, so each field
// interpolates its own constants.
const FIELD_PARAMS: Record<Exclude<JoinField, "code">, Record<string, number>> = {
  email: {},
  password: { min: PASSWORD_MIN_LENGTH },
  name: { min: NAME_MIN_LENGTH },
  subdomain: { min: SUBDOMAIN_MIN_LENGTH, max: SUBDOMAIN_MAX_LENGTH },
};
const KEY_PREFIX = /^(funds|auth|join)\./;

export function JoinForm({ code }: { code: string }) {
  const t = useTranslations("join");
  const tRoot = useTranslations();

  const [pending, startTransition] = useTransition();
  // Set when the answer went by email (the address already has an account —
  // the screen never says so, only that an email went out).
  const [sentTo, setSentTo] = useState<string | null>(null);
  const form = useForm<JoinWithCodeInput, unknown, JoinWithCodeValues>({
    resolver: zodResolver(JoinWithCodeSchema),
    defaultValues: { code, email: "", password: "", name: "", subdomain: "" },
  });

  // Propose the subdomain from the fund name until the person edits it.
  const name = useWatch({ control: form.control, name: "name" });
  const subdomainDirty = form.formState.dirtyFields.subdomain;
  useEffect(() => {
    if (!subdomainDirty) {
      form.setValue("subdomain", toSubdomain(name ?? ""), {
        shouldValidate: false,
        shouldDirty: false,
      });
    }
  }, [name, subdomainDirty, form]);

  const onSubmit = (values: JoinWithCodeValues) =>
    startTransition(async () => {
      const result = await joinWithCodeAction(values);
      if ("error" in result) {
        if (result.field && result.field !== "code") {
          form.setError(result.field, { message: result.error });
        } else {
          form.setError("root", { message: result.error });
        }
        return;
      }
      if ("sentTo" in result) {
        setSentTo(result.sentTo);
        return;
      }
      // A full navigation: the exchange lives on the fund's own host.
      window.location.assign(result.redirectTo);
    });

  const errors = form.formState.errors;
  const fieldError = (field: Exclude<JoinField, "code">) => {
    const message = errors[field]?.message;
    if (!message) return null;
    return KEY_PREFIX.test(message)
      ? tRoot(message as never, FIELD_PARAMS[field] as never)
      : message;
  };

  if (sentTo) {
    return (
      <Alert>
        <AlertDescription>{t("checkInbox", { email: sentTo })}</AlertDescription>
      </Alert>
    );
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
      <fieldset className="space-y-4" disabled={pending}>
        <legend className="text-sm font-medium">{t("account")}</legend>
        <div className="space-y-2">
          <Label htmlFor="email">{t("email")}</Label>
          <Input id="email" type="email" autoComplete="email" {...form.register("email")} />
          {errors.email && <p className="text-sm text-destructive">{fieldError("email")}</p>}
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">{t("password")}</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            {...form.register("password")}
          />
          {errors.password ? (
            <p className="text-sm text-destructive">{fieldError("password")}</p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("passwordHint", { min: PASSWORD_MIN_LENGTH })}
            </p>
          )}
        </div>
      </fieldset>

      <fieldset className="space-y-4" disabled={pending}>
        <legend className="text-sm font-medium">{t("fund")}</legend>
        <div className="space-y-2">
          <Label htmlFor="name">{t("name")}</Label>
          <Input id="name" autoComplete="organization" {...form.register("name")} />
          {errors.name && <p className="text-sm text-destructive">{fieldError("name")}</p>}
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
            <span className="text-sm text-muted-foreground whitespace-nowrap">.{FUND_APEX}</span>
          </div>
          {errors.subdomain && (
            <p className="text-sm text-destructive">{fieldError("subdomain")}</p>
          )}
        </div>
      </fieldset>

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
