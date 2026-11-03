// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { resendMemberVerificationAction } from "@/services/member/auth-actions";

// Link-mode recovery (the login page): a signed-in User whose membership is
// still waiting for the confirmation click asks for the email again.
export function ResendPendingVerification() {
  const t = useTranslations("memberLogin.account.verification");
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resend = () =>
    startTransition(async () => {
      setMessage(null);
      setError(null);
      const result = await resendMemberVerificationAction();
      if ("error" in result) setError(result.error);
      else setMessage(result.message ?? null);
    });

  return (
    <div className="space-y-2">
      {message && (
        <Alert>
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <Button type="button" variant="outline" size="sm" onClick={resend} disabled={pending}>
        {pending ? t("resending") : t("resend")}
      </Button>
    </div>
  );
}
