// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { updateMemberSenderEmailAction } from "@/services/fund/settings-actions";

// Per-fund sender address for member-facing emails. Bare address; the
// display name is the fund name at send time. Blank clears it (falls back to
// the platform default). Same save/error pattern as the other settings forms.
export function MemberSenderForm({
  initialSenderEmail,
}: {
  initialSenderEmail: string | null;
}) {
  const t = useTranslations("fund.settings.emails.sender");
  const tRoot = useTranslations("fund.settings");

  const [senderEmail, setSenderEmail] = useState(initialSenderEmail ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await updateMemberSenderEmailAction({ senderEmail });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setSaved(true);
    });
  };

  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="member-sender-email">{t("label")}</Label>
        <Input
          id="member-sender-email"
          type="email"
          value={senderEmail}
          onChange={(e) => {
            setSaved(false);
            setSenderEmail(e.target.value);
          }}
          placeholder={t("placeholder")}
          autoComplete="off"
          spellCheck={false}
        />
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex items-center justify-between gap-3">
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
