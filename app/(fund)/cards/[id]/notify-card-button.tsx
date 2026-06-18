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
import { notifyCardAssignedAction } from "@/services/card/notify-actions";

// Send (first send), retry (after a failure), or resend (after a prior success)
// the "your card is on its way" email. Sending reaches an external service, so
// it's behind a confirm step. `mode` only changes the trigger label.
export function NotifyCardButton({
  cardId,
  memberName,
  mode,
}: {
  cardId: string;
  memberName: string;
  mode: "send" | "retry" | "resend";
}) {
  const t = useTranslations("cards.admin.notify");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const send = () => {
    setError(null);
    startTransition(async () => {
      const result = await notifyCardAssignedAction({ cardId });
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
        {t(mode)}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("confirmTitle")}</DialogTitle>
          <DialogDescription>
            {t("confirmDescription", { name: memberName })}
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
