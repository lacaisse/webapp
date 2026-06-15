// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { CheckCircle2, Mail, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { notifyPeriodAllocationsAction } from "@/services/allocation-periods/notify-actions";

// Send the allocation-confirmation email to every confirmed mint in the period
// that hasn't already been notified. Already-sent ones are skipped server-side.
export function NotifyAllButton({
  periodId,
  pendingCount,
}: {
  periodId: string;
  // How many confirmed mints still need notifying (for the confirm copy +
  // to disable the button when there's nothing to do). Snapshot at render.
  pendingCount: number;
}) {
  const t = useTranslations("fund.allocations.periodDetail.notify");
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState<
    { sent: number; skipped: number; failed: number } | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const run = () => {
    setConfirmOpen(false);
    setError(null);
    setResult(null);
    startTransition(async () => {
      const res = await notifyPeriodAllocationsAction({ periodId });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setResult({ sent: res.sent, skipped: res.skipped, failed: res.failed });
      router.refresh();
    });
  };

  return (
    <div className="space-y-3">
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogTrigger
          render={
            <Button size="sm" disabled={pending || pendingCount === 0} />
          }
        >
          <Mail className="size-4" />
          {t("allTrigger", { count: pendingCount })}
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("allConfirmTitle")}</DialogTitle>
            <DialogDescription>
              {t("allConfirmDescription", { count: pendingCount })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              {t("cancel")}
            </DialogClose>
            <Button type="button" onClick={run}>
              {t("allConfirmSend")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {result && (
        <Alert>
          <CheckCircle2 className="size-4 text-success" />
          <AlertTitle>{t("allDoneTitle")}</AlertTitle>
          <AlertDescription>
            {t("allDoneSummary", {
              sent: result.sent,
              skipped: result.skipped,
              failed: result.failed,
            })}
          </AlertDescription>
        </Alert>
      )}

      {error && (
        <Alert variant="destructive">
          <TriangleAlert className="size-4" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
