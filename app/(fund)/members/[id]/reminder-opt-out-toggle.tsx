// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useTranslations } from "next-intl";
import { useOptimistic, useState, useTransition } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Checkbox } from "@/components/ui/checkbox";
import { setMemberReminderOptOutAction } from "@/services/member/admin-actions";

// Admin toggle for a member's reminder subscription, on the member detail
// page's email settings card. Optimistic: the checkbox flips immediately and
// reconciles with the server action result, reverting on error. Mirrors the
// public /unsubscribe toggle but goes through the OPERATOR-gated admin action.
export function ReminderOptOutToggle({
  memberId,
  initialUnsubscribed,
  unsubscribedSince,
}: {
  memberId: string;
  initialUnsubscribed: boolean;
  // Server-formatted date of the current opt-out (null when subscribed).
  unsubscribedSince: string | null;
}) {
  const t = useTranslations("fund.members.detail.emailSettings");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [unsubscribed, setUnsubscribed] = useState(initialUnsubscribed);
  const [optimistic, setOptimistic] = useOptimistic(unsubscribed);

  const onToggle = (next: boolean) => {
    setError(null);
    startTransition(async () => {
      setOptimistic(next);
      const res = await setMemberReminderOptOutAction({
        memberId,
        unsubscribe: next,
      });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setUnsubscribed(res.unsubscribed);
    });
  };

  return (
    <div className="space-y-2">
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={optimistic}
          disabled={pending}
          onCheckedChange={(value) => onToggle(value === true)}
        />
        {t("optOutLabel")}
      </label>
      <p className="text-xs text-muted-foreground">
        {optimistic
          ? unsubscribedSince
            ? t("optedOutSince", { date: unsubscribedSince })
            : t("optedOut")
          : t("subscribed")}
      </p>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
