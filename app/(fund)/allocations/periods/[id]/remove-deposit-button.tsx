// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { X } from "lucide-react";
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
import { setBankTransactionPeriodAction } from "@/services/bank-sync/admin-actions";

// Remove a deposit from this allocation period (e.g. a donation from a
// non-profit that isn't a member contribution). The bank transaction itself
// is kept — only its period membership is cleared, so it stops counting in
// the period's totals and member-contribution math. The server action refuses
// deposits already used as a mint source.
export function RemoveDepositButton({
  bankTransactionId,
  label,
}: {
  bankTransactionId: string;
  // Counterpart name / reference shown in the confirmation copy.
  label: string;
}) {
  const t = useTranslations("fund.allocations.periodDetail.removeDeposit");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const remove = () => {
    setError(null);
    startTransition(async () => {
      const result = await setBankTransactionPeriodAction({
        bankTransactionId,
        periodId: null,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpen(false);
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setError(null);
      }}
    >
      <DialogTrigger
        render={
          <Button variant="ghost" size="icon-sm" aria-label={t("button")} />
        }
      >
        <X className="size-3.5" />
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description", { label })}</DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            {t("cancel")}
          </Button>
          <Button variant="destructive" onClick={remove} disabled={pending}>
            {pending ? t("removing") : t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
