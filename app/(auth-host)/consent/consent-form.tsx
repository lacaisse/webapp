// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { consentAction } from "../actions";

// Scopes with a human description. Anything else (there's none today) is
// shown raw rather than hidden — the user must see everything they grant.
const DESCRIBED_SCOPES = new Set([
  "openid",
  "profile",
  "email",
  "offline_access",
]);

export function ConsentForm({
  oauthQuery,
  scopes,
  clientUri,
}: {
  oauthQuery: string;
  scopes: string[];
  clientUri: string | null;
}) {
  const t = useTranslations("auth.consent");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const decide = (accept: boolean) =>
    startTransition(async () => {
      setError(null);
      const result = await consentAction(accept, oauthQuery);
      if ("error" in result) {
        setError(result.error);
      } else if (result.redirectTo) {
        // The agent's redirect_uri (with the code, or access_denied). Full
        // navigation: it's another origin, and OAuth hops never go through
        // the client router — see services/auth/oauth-resume.ts.
        window.location.assign(result.redirectTo);
      }
    });

  return (
    <div className="space-y-4">
      {scopes.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium">{t("scopesTitle")}</p>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {scopes.map((scope) => (
              <li key={scope}>
                {DESCRIBED_SCOPES.has(scope)
                  ? t(`scopes.${scope}` as never)
                  : scope}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="text-xs text-muted-foreground">{t("hint")}</p>

      {clientUri && (
        <p className="text-xs text-muted-foreground break-all">{clientUri}</p>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          className="flex-1"
          onClick={() => decide(false)}
          disabled={pending}
        >
          {t("deny")}
        </Button>
        <Button
          type="button"
          className="flex-1"
          onClick={() => decide(true)}
          disabled={pending}
        >
          {t("accept")}
        </Button>
      </div>
    </div>
  );
}
