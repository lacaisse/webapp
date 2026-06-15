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
import { notifyAllocationAction } from "@/services/allocation-periods/notify-actions";

// Send (or retry) the allocation-confirmation email for one confirmed mint.
// Sending reaches an external service, so it's behind a confirm step.
export function NotifyAllocationButton({
  tokenOperationId,
  memberName,
  amount,
  isRetry,
}: {
  tokenOperationId: string;
  memberName: string;
  amount: string;
  isRetry: boolean;
}) {
  const t = useTranslations("fund.allocations.periodDetail.notify");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const send = () => {
    setError(null);
    startTransition(async () => {
      const result = await notifyAllocationAction({ tokenOperationId });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpen(false);
      router.refresh();
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
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <Mail className="size-3.5" />
        {isRetry ? t("retry") : t("send")}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("confirmTitle")}</DialogTitle>
          <DialogDescription>
            {t("confirmDescription", { name: memberName, amount })}
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
          <Button onClick={send} disabled={pending}>
            {pending ? t("sending") : t("confirmSend")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
