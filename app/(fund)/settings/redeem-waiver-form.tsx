// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { redeemWaiverCodeAction } from "@/services/fund-setup/admin-actions";

// "Have an invite code?" — one field, one button. The action normalises the
// code (case, dashes, look-alike letters), so the field accepts it as typed.
export function RedeemWaiverForm() {
  const t = useTranslations("fund.settings.subscription.redeem");
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  // Set once the action succeeded: the button stays pending until the
  // router.refresh() re-render swaps this card for the waived card.
  const [redeemed, setRedeemed] = useState(false);
  const [transitionPending, startTransition] = useTransition();
  const pending = transitionPending || redeemed;

  const onSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await redeemWaiverCodeAction({ code });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setRedeemed(true);
      router.refresh();
    });
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3 sm:flex-row sm:items-start">
      <div className="flex-1 space-y-1.5">
        <Label htmlFor="waiver-code">{t("label")}</Label>
        <Input
          id="waiver-code"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder="XXXX-XXXX-XXXX"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          className="font-mono uppercase tracking-wider"
          aria-invalid={error ? true : undefined}
          disabled={pending}
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
      <Button type="submit" disabled={pending || code.trim() === ""} className="sm:mt-6">
        {pending ? t("submitting") : t("submit")}
      </Button>
    </form>
  );
}
