// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { reconcileOperationAction } from "@/services/token-operations/reconcile-actions";

// Ask the bundler what actually happened to a token operation (issue #162).
// Read-only against the chain: it never re-mints, it only corrects our record.
// The result is shown in-dialog rather than as a toast, because "still pending"
// is a real answer the admin needs to read, not a transient notice.
export function ReconcileOperationButton({
  operationId,
}: {
  operationId: string;
}) {
  const t = useTranslations("token.reconcile");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const run = () => {
    setError(null);
    setOutcome(null);
    startTransition(async () => {
      const result = await reconcileOperationAction({ operationId });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOutcome(result.outcome);
      router.refresh();
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (pending) return;
        setOpen(o);
        if (!o) {
          setError(null);
          setOutcome(null);
        }
      }}
    >
      <DialogTrigger render={<Button variant="ghost" size="sm" />}>
        <RefreshCw className="size-3.5" />
        {t("trigger")}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        {outcome && (
          <Alert variant={outcome === "failed" ? "destructive" : "default"}>
            <AlertDescription>{t(`outcomes.${outcome}` as never)}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            {outcome ? t("close") : t("cancel")}
          </Button>
          {!outcome && (
            <Button onClick={run} disabled={pending}>
              {pending ? t("checking") : t("confirm")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
