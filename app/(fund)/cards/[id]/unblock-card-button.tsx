// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { LockOpen } from "lucide-react";
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
import { useStepUp } from "@/components/reauth-dialog";
import { unblockCardPinAction } from "@/services/card/pin-block-actions";

// The explicit unblock of a card Citizen Pay blocked after three wrong PIN
// entries (services/card/pin-block-actions.ts). Confirmed in a dialog, and
// behind the step-up: without a re-authentication in the last 10 minutes the
// action answers `reauth_required`, `useStepUp` opens the re-auth dialog on
// top of this one and runs the same submit again once the admin confirmed.
// Only rendered for ADMIN (the page decides).
export function UnblockCardButton({
  cardId,
  holderLabel,
  hasPasskey,
}: {
  cardId: string;
  holderLabel: string;
  hasPasskey: boolean;
}) {
  const t = useTranslations("cards.admin.pinBlock.unblock");
  const router = useRouter();
  const stepUp = useStepUp(hasPasskey);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = () => {
    setError(null);
    startTransition(async () => {
      const result = await unblockCardPinAction({ cardId });
      if (stepUp.check(result, submit)) return;
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpen(false);
      router.refresh();
    });
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next && (pending || stepUp.pending)) return;
          setOpen(next);
          if (!next) setError(null);
        }}
      >
        <DialogTrigger render={<Button size="sm" variant="destructive" />}>
          <LockOpen className="size-3.5" />
          {t("button")}
        </DialogTrigger>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
            <DialogDescription>
              {t("description", { holderLabel })}
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
            <Button variant="destructive" onClick={submit} disabled={pending}>
              {pending ? t("unblocking") : t("confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {stepUp.dialog}
    </>
  );
}
