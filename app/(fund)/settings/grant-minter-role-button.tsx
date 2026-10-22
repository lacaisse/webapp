// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { EnsureMinterRolesResult } from "@/services/citizenpay/token-roles";
import { grantMinterRoleAction } from "@/services/fund/settings-actions";

// "Grant minter role" on the settings Token tab: asks Citizen Pay to grant
// the fund's minter Safe its roles (grantMinterRoleAction → ensureMinterRoles)
// and shows the outcome inline. The action revalidates /settings, so the
// permission badge above re-reads the chain; this component stays mounted
// (the button hides once the role is there) so the outcome stays visible.
export function GrantMinterRoleButton({ showButton }: { showButton: boolean }) {
  const t = useTranslations("fund.settings.token.minter.grant");
  const [result, setResult] = useState<EnsureMinterRolesResult | null>(null);
  const [pending, startTransition] = useTransition();

  const onClick = () => {
    setResult(null);
    startTransition(async () => {
      try {
        setResult(await grantMinterRoleAction());
      } catch {
        setResult({ status: "failed" });
      }
    });
  };

  if (!showButton && !result) return null;

  const variant =
    result?.status === "failed"
      ? "destructive"
      : result?.status === "unsupported"
        ? "warning"
        : "default";

  return (
    <div className="space-y-2">
      {showButton && (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant="outline" size="sm" onClick={onClick} disabled={pending}>
            <ShieldCheck />
            {pending ? t("pending") : t("button")}
          </Button>
          <span className="text-xs text-muted-foreground">{t("hint")}</span>
        </div>
      )}
      {result && !pending && (
        <Alert variant={variant}>
          <AlertDescription>
            <p>{t(result.status)}</p>
            {result.detail && result.status !== "granted" && result.status !== "already" && (
              <p className="font-mono text-xs break-all">
                {t("detail", { detail: result.detail })}
              </p>
            )}
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
