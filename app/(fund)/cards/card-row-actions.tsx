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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  setCardStatusAction,
  topUpCardAction,
  withdrawFromCardAction,
} from "@/services/card/admin-actions";

// Change status: set the card to ACTIVE / INACTIVE / BLOCKED directly, with an
// optional "reported lost" internal flag. Available on every card (it's the
// only path to activate an INACTIVE card or set one back to inactive).
// Top-up / withdraw available on any non-blocked card with a CP-issued account
// — including INACTIVE ones, since a top-up is exactly what flips a factory
// INACTIVE card to ACTIVE on its first charge. Only BLOCKED is excluded.

export function CardRowActions({
  cardId,
  status,
  isLost,
  holderLabel,
  hasAccount,
  tokenSymbol,
  tokenDecimals,
}: {
  cardId: string;
  status: "ACTIVE" | "INACTIVE" | "BLOCKED";
  isLost: boolean;
  holderLabel: string;
  hasAccount: boolean;
  tokenSymbol: string | null;
  tokenDecimals: number | null;
}) {
  const canTransact =
    status !== "BLOCKED" && hasAccount && tokenDecimals != null;
  return (
    <div className="flex items-center justify-end gap-2">
      {canTransact && (
        <>
          <TopUpDialog
            cardId={cardId}
            holderLabel={holderLabel}
            tokenSymbol={tokenSymbol}
          />
          <WithdrawDialog
            cardId={cardId}
            holderLabel={holderLabel}
            tokenSymbol={tokenSymbol}
          />
        </>
      )}
      <ChangeStatusDialog
        cardId={cardId}
        status={status}
        isLost={isLost}
        holderLabel={holderLabel}
      />
    </div>
  );
}

const STATUS_OPTIONS = ["ACTIVE", "INACTIVE", "BLOCKED"] as const;

function ChangeStatusDialog({
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
  const t = useTranslations("cards.admin.status");
  const [open, setOpen] = useState(false);
  const [nextStatus, setNextStatus] = useState(status);
  const [reportedLost, setReportedLost] = useState(isLost);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onOpenChange(next: boolean) {
    if (!next && pending) return;
    setOpen(next);
    setError(null);
    if (next) {
      setNextStatus(status);
      setReportedLost(isLost);
    }
  }

  const dirty = nextStatus !== status || reportedLost !== isLost;

  const onSubmit = () => {
    setError(null);
    startTransition(async () => {
      const result = await setCardStatusAction({
        cardId,
        status: nextStatus,
        reportedLost,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpen(false);
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        {t("button")}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {t("description", { holderLabel })}
          </DialogDescription>
        </DialogHeader>
        <fieldset className="space-y-2">
          <legend className="sr-only">{t("statusLabel")}</legend>
          {STATUS_OPTIONS.map((opt) => (
            <label
              key={opt}
              className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-card p-3 transition-colors hover:bg-muted/40 has-checked:border-primary"
            >
              <input
                type="radio"
                name={`card-status-${cardId}`}
                value={opt}
                checked={nextStatus === opt}
                onChange={() => setNextStatus(opt)}
                className="mt-1 size-4 border-input"
              />
              <div className="flex-1 space-y-0.5">
                <div className="text-sm font-medium">
                  {t(`options.${opt}.label` as never)}
                </div>
                <div className="text-xs text-muted-foreground">
                  {t(`options.${opt}.description` as never)}
                </div>
              </div>
            </label>
          ))}
        </fieldset>
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
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            {t("cancel")}
          </Button>
          <Button onClick={onSubmit} disabled={pending || !dirty}>
            {pending ? t("saving") : t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TopUpDialog({
  cardId,
  holderLabel,
  tokenSymbol,
}: {
  cardId: string;
  holderLabel: string;
  tokenSymbol: string | null;
}) {
  return (
    <CardAmountDialog
      cardId={cardId}
      holderLabel={holderLabel}
      tokenSymbol={tokenSymbol}
      kind="topUp"
      action={topUpCardAction}
    />
  );
}

function WithdrawDialog({
  cardId,
  holderLabel,
  tokenSymbol,
}: {
  cardId: string;
  holderLabel: string;
  tokenSymbol: string | null;
}) {
  return (
    <CardAmountDialog
      cardId={cardId}
      holderLabel={holderLabel}
      tokenSymbol={tokenSymbol}
      kind="withdraw"
      action={withdrawFromCardAction}
    />
  );
}

function CardAmountDialog({
  cardId,
  holderLabel,
  tokenSymbol,
  kind,
  action,
}: {
  cardId: string;
  holderLabel: string;
  tokenSymbol: string | null;
  kind: "topUp" | "withdraw";
  action: typeof topUpCardAction;
}) {
  const t = useTranslations(`cards.admin.${kind}`);
  const tRoot = useTranslations();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setAmount("");
      setError(null);
      setSuccess(null);
    }
  }

  const onSubmit = () => {
    setError(null);
    startTransition(async () => {
      const result = await action({ cardId, amount });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setSuccess(result.txHash);
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button variant={kind === "topUp" ? "default" : "outline"} size="sm" />
        }
      >
        {t("button")}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {t("description", { holderLabel })}
          </DialogDescription>
        </DialogHeader>
        {success ? (
          <div className="space-y-2">
            <Alert>
              <AlertDescription>
                <div>{t("success")}</div>
                <div className="mt-1 font-mono text-xs break-all">
                  {success}
                </div>
              </AlertDescription>
            </Alert>
          </div>
        ) : (
          <div className="space-y-2">
            <Label htmlFor={`${kind}-amount-${cardId}`}>
              {t("amountLabel")}
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id={`${kind}-amount-${cardId}`}
                autoComplete="off"
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
              {tokenSymbol && (
                <span className="text-sm text-muted-foreground whitespace-nowrap">
                  {tokenSymbol}
                </span>
              )}
            </div>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </div>
        )}
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            {success ? tRoot("common.close") : tRoot("common.cancel")}
          </Button>
          {!success && (
            <Button
              variant={kind === "withdraw" ? "destructive" : "default"}
              onClick={onSubmit}
              disabled={pending}
            >
              {pending ? t("submitting") : t("confirm")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

