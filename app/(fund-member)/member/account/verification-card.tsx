// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { CheckCircle2, MailWarning } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { resendMemberVerificationAction } from "@/services/member/auth-actions";

// Whether the login's email is verified. Until it is, the member's cards are
// not attached (they stay public) — so the pending state explains that and
// offers a fresh verification email.
export function VerificationCard({ verified }: { verified: boolean }) {
  const t = useTranslations("memberLogin.account.verification");
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (verified) {
    return (
      <p className="flex items-center gap-2 text-sm text-emerald-700">
        <CheckCircle2 className="size-4" />
        {t("verified")}
      </p>
    );
  }

  const resend = () =>
    startTransition(async () => {
      setMessage(null);
      setError(null);
      const result = await resendMemberVerificationAction();
      if ("error" in result) setError(result.error);
      else setMessage(result.message ?? null);
    });

  return (
    <div className="space-y-3">
      <Alert>
        <MailWarning className="size-4" />
        <AlertDescription>
          <span className="font-medium">{t("pending")}</span> {t("pendingHelp")}
        </AlertDescription>
      </Alert>
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
