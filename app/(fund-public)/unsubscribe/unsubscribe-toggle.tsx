// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { setReminderOptOutAction } from "@/services/member/unsubscribe-actions";

// Toggle for the public opt-out page. Starts from the member's current state
// (server-rendered) and flips it via the server action — confirm-style, so
// visiting the link never mutates. Reversible: an opted-out member sees a
// "resubscribe" button and vice-versa.
export function UnsubscribeToggle({
  token,
  initialUnsubscribed,
}: {
  token: string;
  initialUnsubscribed: boolean;
}) {
  const t = useTranslations("unsubscribe");
  const [unsubscribed, setUnsubscribed] = useState(initialUnsubscribed);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onToggle = () => {
    setError(null);
    const next = !unsubscribed;
    startTransition(async () => {
      const result = await setReminderOptOutAction({
        token,
        unsubscribe: next,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setUnsubscribed(result.unsubscribed);
    });
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {unsubscribed ? t("status.unsubscribed") : t("status.subscribed")}
      </p>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Button
        onClick={onToggle}
        disabled={pending}
        variant={unsubscribed ? "outline" : "default"}
        className="w-full"
      >
        {pending
          ? t("saving")
          : unsubscribed
            ? t("resubscribe")
            : t("unsubscribe")}
      </Button>
    </div>
  );
}
