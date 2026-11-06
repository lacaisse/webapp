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
  confirmCardHolderClaimAction,
  refuseCardHolderClaimAction,
} from "@/services/card/holder-claim-actions";

// Row actions on a PENDING wallet claim (holder-claims-panel.tsx). Confirm
// runs straight away (it is what the holder asked for); Refuse closes the
// claim for good, so it sits behind an in-app confirmation.
export function HolderClaimActions({
  claimId,
  serial,
  memberName,
}: {
  claimId: string;
  /** Already masked in privacy mode. */
  serial: string;
  /** Already masked in privacy mode. */
  memberName: string;
}) {
  const t = useTranslations("fund.cards.holderClaims");
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onConfirm = () => {
    setError(null);
    startTransition(async () => {
      const res = await confirmCardHolderClaimAction({ claimId });
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
        <Button size="sm" onClick={onConfirm} disabled={pending}>
          {pending ? t("confirming") : t("confirm")}
        </Button>
        <RefuseClaimDialog
          claimId={claimId}
          serial={serial}
          memberName={memberName}
          disabled={pending}
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

function RefuseClaimDialog({
  claimId,
  serial,
  memberName,
  disabled,
}: {
  claimId: string;
  serial: string;
  memberName: string;
  disabled: boolean;
}) {
  const t = useTranslations("fund.cards.holderClaims");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onOpenChange(next: boolean) {
    if (!next && pending) return;
    setOpen(next);
    setError(null);
  }

  const onRefuse = () => {
    setError(null);
    startTransition(async () => {
      const res = await refuseCardHolderClaimAction({ claimId });
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
        {t("refuse")}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("refuseTitle")}</DialogTitle>
          <DialogDescription>
            {t("refuseDescription", { serial, member: memberName })}
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
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            {t("dismiss")}
          </Button>
          <Button variant="destructive" onClick={onRefuse} disabled={pending}>
            {pending ? t("refusing") : t("confirmRefuse")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
