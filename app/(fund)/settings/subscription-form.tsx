// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Controller, useForm } from "react-hook-form";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { acceptSubscriptionAction } from "@/services/fund-setup/admin-actions";
import {
  AcceptSubscriptionSchema,
  BILLING_LEGAL_NAME_MAX,
  BILLING_LEGAL_NAME_MIN,
  type AcceptSubscriptionInput,
  type AcceptSubscriptionValues,
} from "@/services/fund-setup/schema";

// Same tokens as components/ui/input.tsx, minus the fixed height — there is
// no Textarea component in this kit.
const TEXTAREA_CLASS =
  "w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1.5 text-base transition-colors outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40";

export function SubscriptionForm({
  fundName,
  defaults,
  price,
}: {
  fundName: string;
  defaults: { legalName: string; email: string };
  price: string;
}) {
  const t = useTranslations("fund.settings.subscription");
  const tRoot = useTranslations();
  const router = useRouter();
  const [transitionPending, startTransition] = useTransition();
  // Set once the action succeeded: the button stays pending until the
  // router.refresh() re-render swaps this form for the accepted card.
  const [submitted, setSubmitted] = useState(false);
  const [alreadyAccepted, setAlreadyAccepted] = useState(false);
  const pending = transitionPending || submitted;

  const form = useForm<AcceptSubscriptionInput, unknown, AcceptSubscriptionValues>({
    resolver: zodResolver(AcceptSubscriptionSchema),
    defaultValues: {
      legalName: defaults.legalName,
      email: defaults.email,
      address: "",
      vatNumber: "",
      accepted: false as unknown as true,
    },
  });

  const onSubmit = (values: AcceptSubscriptionValues) =>
    startTransition(async () => {
      const result = await acceptSubscriptionAction(values);
      if ("error" in result) {
        form.setError(result.field ?? "root", { message: result.error });
        return;
      }
      // No success flash: the server re-render replaces the form with the
      // accepted card. A submit that recorded nothing (someone else accepted
      // first) says so instead of implying a confirmation went out.
      if (result.alreadyAccepted) setAlreadyAccepted(true);
      else setSubmitted(true);
      router.refresh();
    });

  const errors = form.formState.errors;
  const translateError = (msg: string | undefined) => {
    if (!msg) return null;
    if (msg.startsWith("fund.")) {
      return tRoot(msg as never, {
        min: BILLING_LEGAL_NAME_MIN,
        max: BILLING_LEGAL_NAME_MAX,
      } as never);
    }
    return msg;
  };
  const fieldError = (msg: string | undefined) =>
    msg ? <p className="text-sm text-destructive">{translateError(msg)}</p> : null;

  if (alreadyAccepted) {
    return (
      <Alert>
        <AlertDescription>{t("errors.alreadyAccepted")}</AlertDescription>
      </Alert>
    );
  }

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="subscription-legal-name">{t("form.legalName")}</Label>
        <Input
          id="subscription-legal-name"
          autoComplete="organization"
          aria-invalid={errors.legalName ? true : undefined}
          {...form.register("legalName")}
        />
        <p className="text-xs text-muted-foreground">{t("form.legalNameHint")}</p>
        {fieldError(errors.legalName?.message)}
      </div>

      <div className="space-y-2">
        <Label htmlFor="subscription-email">{t("form.email")}</Label>
        <Input
          id="subscription-email"
          type="email"
          autoComplete="email"
          aria-invalid={errors.email ? true : undefined}
          {...form.register("email")}
        />
        <p className="text-xs text-muted-foreground">{t("form.emailHint")}</p>
        {fieldError(errors.email?.message)}
      </div>

      <div className="space-y-2">
        <Label htmlFor="subscription-address">{t("form.address")}</Label>
        <textarea
          id="subscription-address"
          rows={3}
          autoComplete="street-address"
          className={cn(TEXTAREA_CLASS)}
          aria-invalid={errors.address ? true : undefined}
          {...form.register("address")}
        />
        <p className="text-xs text-muted-foreground">{t("form.addressHint")}</p>
        {fieldError(errors.address?.message)}
      </div>

      <div className="space-y-2">
        <Label htmlFor="subscription-vat">{t("form.vatNumber")}</Label>
        <Input
          id="subscription-vat"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={errors.vatNumber ? true : undefined}
          {...form.register("vatNumber")}
        />
        <p className="text-xs text-muted-foreground">{t("form.vatNumberHint")}</p>
        {fieldError(errors.vatNumber?.message)}
      </div>

      <div className="space-y-2">
        <div className="flex items-start gap-2">
          <Controller
            control={form.control}
            name="accepted"
            render={({ field }) => (
              <Checkbox
                id="subscription-accept"
                checked={field.value === true}
                onCheckedChange={(checked) => field.onChange(checked)}
                onBlur={field.onBlur}
                inputRef={field.ref}
                aria-invalid={errors.accepted ? true : undefined}
                className="mt-0.5"
              />
            )}
          />
          <Label htmlFor="subscription-accept" className="text-sm font-normal">
            {t("form.accept", { fundName, price })}
          </Label>
        </div>
        {fieldError(errors.accepted?.message)}
      </div>

      {errors.root && (
        <Alert variant="destructive">
          <AlertDescription>{errors.root.message}</AlertDescription>
        </Alert>
      )}

      <Button type="submit" disabled={pending}>
        {pending ? t("form.submitting") : t("form.submit")}
      </Button>
    </form>
  );
}
