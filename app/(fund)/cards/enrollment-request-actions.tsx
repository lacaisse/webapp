// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

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
import {
  acceptCardEnrollmentRequestAction,
  cancelCardEnrollmentRequestAction,
  rejectCardEnrollmentRequestAction,
} from "@/services/card/enrollment-request-actions";

// Row actions for the cross-fund card enrollment requests panel. Accept runs
// straight away (it is what the issuer is being asked for); Reject and Cancel
// close the request for good, so they sit behind an in-app confirmation.

type ActionResult = { ok: true } | { error: string };

/** Accept / Reject on a PENDING request for one of this fund's cards. */
export function IncomingRequestActions({
  requestId,
  serial,
  fundName,
}: {
  requestId: string;
  serial: string;
  fundName: string;
}) {
  const t = useTranslations("fund.cards.enrollmentRequests");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onAccept = () => {
    setError(null);
    startTransition(async () => {
      const res = await acceptCardEnrollmentRequestAction({ requestId });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center justify-end gap-1.5">
        <Button size="sm" onClick={onAccept} disabled={pending}>
          {pending ? t("accepting") : t("accept")}
        </Button>
        <ConfirmRequestDialog
          trigger={t("reject")}
          title={t("rejectTitle")}
          description={t("rejectDescription", { serial, fund: fundName })}
          confirm={t("confirmReject")}
          confirming={t("rejecting")}
          dismiss={t("dismiss")}
          disabled={pending}
          run={() => rejectCardEnrollmentRequestAction({ requestId })}
        />
      </div>
      {error && (
        <Alert variant="destructive" className="max-w-xs text-left">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

/** Cancel on a PENDING request this fund sent to another fund. */
export function OutgoingRequestActions({
  requestId,
  serial,
  fundName,
}: {
  requestId: string;
  serial: string;
  fundName: string;
}) {
  const t = useTranslations("fund.cards.enrollmentRequests");
  return (
    <div className="flex justify-end">
      <ConfirmRequestDialog
        trigger={t("cancel")}
        title={t("cancelTitle")}
        description={t("cancelDescription", { serial, fund: fundName })}
        confirm={t("confirmCancel")}
        confirming={t("cancelling")}
        dismiss={t("dismiss")}
        run={() => cancelCardEnrollmentRequestAction({ requestId })}
      />
    </div>
  );
}

function ConfirmRequestDialog({
  trigger,
  title,
  description,
  confirm,
  confirming,
  dismiss,
  disabled = false,
  run,
}: {
  trigger: string;
  title: string;
  description: string;
  confirm: string;
  confirming: string;
  dismiss: string;
  disabled?: boolean;
  run: () => Promise<ActionResult>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onOpenChange(next: boolean) {
    if (!next && pending) return;
    setOpen(next);
    setError(null);
  }

  const onConfirm = () => {
    setError(null);
    startTransition(async () => {
      const res = await run();
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={<Button variant="outline" size="sm" disabled={disabled} />}
      >
        {trigger}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            {dismiss}
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={pending}>
            {pending ? confirming : confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
