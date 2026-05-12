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
import {
  blockCardAction,
  unblockCardAction,
} from "@/services/card/admin-actions";

// Block: ACTIVE → BLOCKED. Optionally also flag as lost in the same click.
// Unblock: BLOCKED → ACTIVE. Optionally also clear the lost flag.
// INACTIVE cards (not yet CP-confirmed) render no actions.

export function CardRowActions({
  cardId,
  status,
  isLost,
  holderLabel,
}: {
  cardId: string;
  status: "ACTIVE" | "INACTIVE" | "BLOCKED";
  isLost: boolean;
  holderLabel: string;
}) {
  if (status === "ACTIVE") {
    return (
      <BlockDialog
        cardId={cardId}
        holderLabel={holderLabel}
        initialReportedLost={isLost}
      />
    );
  }
  if (status === "BLOCKED") {
    return (
      <UnblockDialog
        cardId={cardId}
        holderLabel={holderLabel}
        isLost={isLost}
      />
    );
  }
  return null;
}

function BlockDialog({
  cardId,
  holderLabel,
  initialReportedLost,
}: {
  cardId: string;
  holderLabel: string;
  initialReportedLost: boolean;
}) {
  const t = useTranslations("cards.admin.block");
  const [open, setOpen] = useState(false);
  const [reportedLost, setReportedLost] = useState(initialReportedLost);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onSubmit = () => {
    setError(null);
    startTransition(async () => {
      const result = await blockCardAction({ cardId, reportedLost });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpen(false);
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="destructive" size="sm" />}>
        {t("button")}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {t("description", { holderLabel })}
          </DialogDescription>
        </DialogHeader>
        <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-card p-3 transition-colors hover:bg-muted/40">
          <input
            type="checkbox"
            checked={reportedLost}
            onChange={(e) => setReportedLost(e.target.checked)}
            className="mt-1 size-4 rounded border-input"
          />
          <div className="flex-1 space-y-0.5">
            <div className="text-sm font-medium">{t("lostLabel")}</div>
            <div className="text-xs text-muted-foreground">
              {t("lostDescription")}
            </div>
          </div>
        </label>
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
          <Button variant="destructive" onClick={onSubmit} disabled={pending}>
            {pending ? t("blocking") : t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UnblockDialog({
  cardId,
  holderLabel,
  isLost,
}: {
  cardId: string;
  holderLabel: string;
  isLost: boolean;
}) {
  const t = useTranslations("cards.admin.unblock");
  const [open, setOpen] = useState(false);
  const [clearLostFlag, setClearLostFlag] = useState(isLost);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onSubmit = () => {
    setError(null);
    startTransition(async () => {
      const result = await unblockCardAction({ cardId, clearLostFlag });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpen(false);
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button variant="default" size="sm" />}>
        {t("button")}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {t("description", { holderLabel })}
          </DialogDescription>
        </DialogHeader>
        {isLost && (
          <label className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-card p-3 transition-colors hover:bg-muted/40">
            <input
              type="checkbox"
              checked={clearLostFlag}
              onChange={(e) => setClearLostFlag(e.target.checked)}
              className="mt-1 size-4 rounded border-input"
            />
            <div className="flex-1 space-y-0.5">
              <div className="text-sm font-medium">{t("clearLostLabel")}</div>
              <div className="text-xs text-muted-foreground">
                {t("clearLostDescription")}
              </div>
            </div>
          </label>
        )}
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
          <Button onClick={onSubmit} disabled={pending}>
            {pending ? t("unblocking") : t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
