// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { Mail } from "lucide-react";
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
import { remindUnpaidMemberAction } from "@/services/allocation-periods/remind-actions";

// Send (retry, or send again on a later day) the manual payment reminder for
// one unpaid member. Sending reaches an external service, so it's behind a
// confirm step. Mirrors NotifyAllocationButton.
export function RemindMemberButton({
  periodId,
  memberId,
  memberName,
  label,
}: {
  periodId: string;
  memberId: string;
  memberName: string;
  // "retry" = today's attempt failed; "sendAgain" = nudged on an earlier day.
  label: "send" | "retry" | "sendAgain";
}) {
  const t = useTranslations("fund.allocations.periodDetail.remind");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Second stage: member emails are paused fund-wide, so the dialog switches to
  // an explicit "send anyway" confirmation before we override the pause.
  const [pausedConfirm, setPausedConfirm] = useState(false);
  const [pending, startTransition] = useTransition();

  const send = (overridePause = false) => {
    setError(null);
    startTransition(async () => {
      const result = await remindUnpaidMemberAction({
        periodId,
        memberId,
        overridePause,
      });
      if ("pausedConfirmRequired" in result) {
        setPausedConfirm(true);
        return;
      }
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpen(false);
      setPausedConfirm(false);
      router.refresh();
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) {
          setError(null);
          setPausedConfirm(false);
        }
      }}
    >
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <Mail className="size-3.5" />
        {t(label)}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {pausedConfirm ? t("pausedConfirmTitle") : t("confirmTitle")}
          </DialogTitle>
          <DialogDescription>
            {pausedConfirm
              ? t("pausedConfirmDescription", { name: memberName })
              : t("confirmDescription", { name: memberName })}
          </DialogDescription>
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
          <Button onClick={() => send(pausedConfirm)} disabled={pending}>
            {pending
              ? t("sending")
              : pausedConfirm
                ? t("pausedConfirmSend")
                : t("confirmSend")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
