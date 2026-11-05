// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useForm } from "react-hook-form";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { redeemWaiverCodeAction } from "@/services/fund-setup/admin-actions";
import { RedeemWaiverCodeSchema, type RedeemWaiverCodeInput } from "@/services/fund-setup/schema";

// "Have an invite code?" — one field, one button. The shared schema validates
// the shape client-side (its messages are translation keys); the action
// re-validates and answers with translated text. Both normalise the code, so
// the field accepts it as typed (case, dashes, look-alike letters).
export function RedeemWaiverForm() {
  const t = useTranslations("fund.settings.subscription.redeem");
  const tRoot = useTranslations();
  const router = useRouter();
  const [transitionPending, startTransition] = useTransition();
  // Set once the action succeeded: the button stays pending until the
  // router.refresh() re-render swaps this card for the waived card.
  const [redeemed, setRedeemed] = useState(false);
  const pending = transitionPending || redeemed;

  const form = useForm<RedeemWaiverCodeInput>({
    resolver: zodResolver(RedeemWaiverCodeSchema),
    defaultValues: { code: "" },
  });

  const onSubmit = (values: RedeemWaiverCodeInput) =>
    startTransition(async () => {
      const result = await redeemWaiverCodeAction(values);
      if ("error" in result) {
        form.setError("code", { message: result.error });
        return;
      }
      setRedeemed(true);
      router.refresh();
    });

  const message = form.formState.errors.code?.message;
  const error = message
    ? message.startsWith("fund.")
      ? tRoot(message as never)
      : message
    : null;

  return (
    <form
      onSubmit={form.handleSubmit(onSubmit)}
      className="flex flex-col gap-3 sm:flex-row sm:items-start"
    >
      <div className="flex-1 space-y-1.5">
        <Label htmlFor="waiver-code">{t("label")}</Label>
        <Input
          id="waiver-code"
          placeholder="XXXX-XXXX-XXXX"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          className="font-mono uppercase tracking-wider"
          aria-invalid={error ? true : undefined}
          disabled={pending}
          {...form.register("code")}
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
      <Button type="submit" disabled={pending} className="sm:mt-6">
        {pending ? t("submitting") : t("submit")}
      </Button>
    </form>
  );
}
