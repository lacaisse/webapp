// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { ShieldAlert } from "lucide-react";

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
//
// `pinBlocked`: Citizen Pay blocked the card after three wrong PIN entries.
// That block is the api's — the status dialog explains and refuses, the
// card page's Unblock (ADMIN + step-up) is the way out.

export function CardRowActions({
  cardId,
  status,
  isLost,
  pinBlocked = false,
  holderLabel,
  hasAccount,
  tokenSymbol,
  tokenDecimals,
}: {
  cardId: string;
  status: "ACTIVE" | "INACTIVE" | "BLOCKED";
  isLost: boolean;
  pinBlocked?: boolean;
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
        pinBlocked={pinBlocked}
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
  pinBlocked,
  holderLabel,
}: {
  cardId: string;
  status: "ACTIVE" | "INACTIVE" | "BLOCKED";
  isLost: boolean;
  pinBlocked: boolean;
  holderLabel: string;
}) {
  const t = useTranslations("cards.admin.status");
  const tPin = useTranslations("cards.admin.pinBlock");
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
        {pinBlocked && (
          <Alert variant="destructive">
            <ShieldAlert />
            <AlertDescription>{tPin("statusDialog.notice")}</AlertDescription>
          </Alert>
        )}
        <fieldset className="space-y-2" disabled={pinBlocked}>
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
          <Button onClick={onSubmit} disabled={pending || !dirty || pinBlocked}>
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

