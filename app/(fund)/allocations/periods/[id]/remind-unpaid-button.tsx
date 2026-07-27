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
import { remindPeriodUnpaidAction } from "@/services/allocation-periods/remind-actions";

// Send a payment reminder to every unpaid member who can still be reminded
// (has an email, not opted out, not already reminded). Already-reminded members
// are skipped server-side. Mirrors NotifyAllButton.
export function RemindUnpaidButton({
  periodId,
  pendingCount,
}: {
  periodId: string;
  // How many unpaid members can still be reminded (drives the confirm copy +
  // disables the button when there's nothing to do). Snapshot at render.
  pendingCount: number;
}) {
  const t = useTranslations("fund.allocations.periodDetail.remind");
  const router = useRouter();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [result, setResult] = useState<
    { sent: number; skipped: number; failed: number } | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  // Second stage: member emails are paused fund-wide, so the dialog switches to
  // an explicit "send anyway" confirmation before we override the pause.
  const [pausedConfirm, setPausedConfirm] = useState(false);
  const [pending, startTransition] = useTransition();

  // The dialog stays open until the send actually succeeds, so the paused
  // confirmation (and any error) has somewhere to render.
  const run = (overridePause = false) => {
    setError(null);
    setResult(null);
    startTransition(async () => {
      const res = await remindPeriodUnpaidAction({ periodId, overridePause });
      if ("pausedConfirmRequired" in res) {
        setPausedConfirm(true);
        return;
      }
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setConfirmOpen(false);
      setPausedConfirm(false);
      setResult({ sent: res.sent, skipped: res.skipped, failed: res.failed });
      router.refresh();
    });
  };

  return (
    <div className="space-y-3">
      <Dialog
        open={confirmOpen}
        onOpenChange={(o) => {
          setConfirmOpen(o);
          if (!o) {
            setError(null);
            setPausedConfirm(false);
          }
        }}
      >
        <DialogTrigger
          render={<Button size="sm" disabled={pending || pendingCount === 0} />}
        >
          <Mail className="size-4" />
          {t("allTrigger", { count: pendingCount })}
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {pausedConfirm ? t("pausedConfirmTitle") : t("allConfirmTitle")}
            </DialogTitle>
            <DialogDescription>
              {pausedConfirm
                ? t("allPausedConfirmDescription", { count: pendingCount })
                : t("allConfirmDescription", { count: pendingCount })}
            </DialogDescription>
          </DialogHeader>
          {error && (
            <Alert variant="destructive">
              <TriangleAlert className="size-4" />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              {t("cancel")}
            </DialogClose>
            <Button
              type="button"
              onClick={() => run(pausedConfirm)}
              disabled={pending}
            >
              {pending
                ? t("sending")
                : pausedConfirm
                  ? t("pausedConfirmSend")
                  : t("allConfirmSend")}
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

    </div>
  );
}
