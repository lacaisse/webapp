// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { confirmMemberVerificationAction } from "@/services/member/auth-actions";

// The POST that consumes a member-login verification token: only the
// signed-in owner of that login can click it (the action re-checks), and a
// GET of the link — a scanner, a forward — consumes nothing.
export function ConfirmLoginVerification({ token }: { token: string }) {
  const t = useTranslations("memberLogin.verify");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const confirm = () =>
    startTransition(async () => {
      setError(null);
      const result = await confirmMemberVerificationAction(token);
      if ("error" in result) setError(result.error);
      else if (result.redirectTo) window.location.assign(result.redirectTo);
    });

  return (
    <div className="space-y-4">
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Button type="button" className="w-full" onClick={confirm} disabled={pending}>
        {pending ? t("confirming") : t("confirm")}
      </Button>
    </div>
  );
}
