// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { Link2 } from "lucide-react";
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
import { sendMemberPaymentLinkAction } from "@/services/member/payment-link-actions";

// Send the member their payment link / account page on request (issue #45).
// Sending reaches an external service and is visible to the member, so it sits
// behind a confirm step. `alreadySent` only changes the trigger label — a
// repeat click is an explicit "send again".
export function SendPaymentLinkButton({
  memberId,
  memberName,
  alreadySent,
}: {
  memberId: string;
  memberName: string;
  alreadySent: boolean;
}) {
  const t = useTranslations("members.admin.paymentLink");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const send = () => {
    setError(null);
    startTransition(async () => {
      const result = await sendMemberPaymentLinkAction({ memberId });
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
        if (pending) return;
        setOpen(o);
        if (!o) setError(null);
      }}
    >
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        <Link2 className="size-3.5" />
        {t(alreadySent ? "resend" : "send")}
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
            {pending ? t("sending") : t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
