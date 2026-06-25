// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

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
import { unassignCardAction } from "@/services/card/admin-actions";

// Detach a card from its member. Destructive-ish (it drops the holder link and,
// if primary, the member's primary card), so it sits behind a confirm dialog
// per the in-app-confirmation rule. Balance is untouched — the operator moves
// it separately with the transfer flow if it should follow the holder.

export function UnassignCardButton({
  cardId,
  holderLabel,
  isPrimary,
  size = "sm",
  variant = "outline",
}: {
  cardId: string;
  holderLabel: string;
  isPrimary: boolean;
  size?: "sm" | "default";
  variant?: "outline" | "ghost";
}) {
  const t = useTranslations("cards.admin.unassign");
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
      const result = await unassignCardAction({ cardId });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpen(false);
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger render={<Button variant={variant} size={size} />}>
        {t("button")}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {t("description", { holderLabel })}
          </DialogDescription>
        </DialogHeader>
        {isPrimary && (
          <Alert variant="warning">
            <AlertDescription>{t("primaryWarning")}</AlertDescription>
          </Alert>
        )}
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
            {t("cancel")}
          </Button>
          <Button
            variant="destructive"
            onClick={onConfirm}
            disabled={pending}
          >
            {pending ? t("confirming") : t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
