// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { ArchiveRestore, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { unarchiveSafeAction } from "@/services/safe/admin-actions";

// Restore an archived Safe to the list (review S7). The action re-checks
// that the user is an owner of the Safe or a fund OWNER.
export function UnarchiveButton({ safeId }: { safeId: string }) {
  const t = useTranslations("fund.safes.archived");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onClick = () => {
    setError(null);
    startTransition(async () => {
      const res = await unarchiveSafeAction({ safeId });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button type="button" size="sm" variant="outline" onClick={onClick} disabled={pending}>
        {pending ? <Loader2 className="size-4 animate-spin" /> : <ArchiveRestore className="size-4" />}
        {pending ? t("restoring") : t("restore")}
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
