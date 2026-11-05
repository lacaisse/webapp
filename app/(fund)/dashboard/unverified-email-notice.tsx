// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { MailWarning } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { resendVerificationEmailAction } from "@/services/auth/verification-actions";

// Shown while the signed-in account's email is unverified — an account the
// apex /join door created. The verification link went out at creation; this
// offers it again. Disappears on its own once the link was opened (the page
// reads User.emailVerified).
export function UnverifiedEmailNotice({ email }: { email: string }) {
  const t = useTranslations("fund.dashboard.unverifiedEmail");
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<"idle" | "sent" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const resend = () =>
    startTransition(async () => {
      const result = await resendVerificationEmailAction();
      if ("error" in result) {
        setError(result.error);
        setState("error");
        return;
      }
      setError(null);
      setState("sent");
    });

  return (
    <Alert variant="warning">
      <MailWarning className="size-4" />
      <AlertTitle>{t("title")}</AlertTitle>
      <AlertDescription>
        <p>{t("description", { email })}</p>
        <div className="mt-2 flex flex-wrap items-center gap-3">
          <Button type="button" size="sm" variant="outline" onClick={resend} disabled={pending || state === "sent"}>
            {pending ? t("resending") : state === "sent" ? t("resent") : t("resend")}
          </Button>
          {state === "error" && error && <span className="text-sm">{error}</span>}
        </div>
      </AlertDescription>
    </Alert>
  );
}
