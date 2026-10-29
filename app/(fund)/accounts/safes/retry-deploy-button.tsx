// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { Loader2, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { retrySafeDeploymentAction } from "@/services/safe/admin-actions";

// Re-runs a FAILED Safe deployment (same predicted address).
export function RetryDeployButton({ safeId }: { safeId: string }) {
  const t = useTranslations("fund.safes");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onClick = () => {
    setError(null);
    startTransition(async () => {
      const result = await retrySafeDeploymentAction({ safeId });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  };

  return (
    <span className="inline-flex flex-col items-start gap-1">
      <Button
        type="button"
        variant="outline"
        size="xs"
        onClick={onClick}
        disabled={pending}
      >
        {pending ? <Loader2 className="animate-spin" /> : <RotateCcw />}
        {t("retryDeploy")}
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </span>
  );
}
