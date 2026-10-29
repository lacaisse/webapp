// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { syncSafeAction } from "@/services/safe/admin-actions";

// Pulls owners / threshold from chain and imports Safe{Wallet} signatures.
export function SyncButton({ safeId }: { safeId: string }) {
  const t = useTranslations("fund.safes.tx");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onClick = () => {
    setError(null);
    startTransition(async () => {
      const result = await syncSafeAction({ safeId });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  };

  return (
    <span className="inline-flex items-center gap-2">
      {error && <span className="text-xs text-destructive">{error}</span>}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onClick}
        disabled={pending}
        title={t("refreshHint")}
      >
        <RefreshCw className={cn("size-3.5", pending && "animate-spin")} />
        {t("refresh")}
      </Button>
    </span>
  );
}
