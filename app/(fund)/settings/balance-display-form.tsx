// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { updateBalanceDisplayAction } from "@/services/fund/settings-actions";

type Values = { showNativeBalance: boolean; showEureBalance: boolean };

// Settings → Token: which balances besides the fund token the Accounts pages
// show on named accounts and Safes.
export function BalanceDisplayForm({ initial }: { initial: Values }) {
  const t = useTranslations("fund.settings.token.balances");
  const tRoot = useTranslations("fund.settings");
  const [values, setValues] = useState<Values>(initial);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const set = (key: keyof Values, value: boolean) => {
    setSaved(false);
    setValues((prev) => ({ ...prev, [key]: value }));
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await updateBalanceDisplayAction(values);
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setSaved(true);
    });
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">{t("title")}</h3>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>
      <div className="space-y-3">
        <Row
          id="balance-display-native"
          label={t("native")}
          hint={t("nativeHint")}
          checked={values.showNativeBalance}
          onChange={(v) => set("showNativeBalance", v)}
        />
        <Row
          id="balance-display-eure"
          label={t("eure")}
          hint={t("eureHint")}
          checked={values.showEureBalance}
          onChange={(v) => set("showEureBalance", v)}
        />
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {saved && !pending ? tRoot("saved") : null}
        </div>
        <Button type="submit" disabled={pending}>
          {pending ? tRoot("saving") : tRoot("save")}
        </Button>
      </div>
    </form>
  );
}

function Row({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-3">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(v) => onChange(v === true)}
        className="mt-0.5"
      />
      <div className="space-y-0.5">
        <Label htmlFor={id} className="cursor-pointer">
          {label}
        </Label>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
    </div>
  );
}
