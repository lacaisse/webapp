// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { CheckCircle2, Loader2, Pencil, Trash2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
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
  clearManualDeductionAction,
  setManualDeductionAction,
} from "@/services/payout/admin-actions";
import {
  fromCents,
  maxManualDeductionCents,
  payoutNet,
  toCents,
} from "@/services/payout/money";

// Set/clear a payout's manual deduction — a ledger adjustment that lowers the
// net the merchant is paid. Nothing moves now: the deducted tokens leave the
// place's wallet alongside the platform fees at the settlement sweep.
// Pre-filled with the current value; the projected net updates live. The server
// re-validates and is the final authority on the bound + the "not complete" rule.
export function ManualDeductionDialog({
  payoutId,
  amount,
  comment,
  total,
  fees,
  payoutFees,
}: {
  payoutId: string;
  amount: string; // current deduction, EUR decimal
  comment: string | null;
  total: string; // EUR decimal
  fees: string; // EUR decimal — processor cut withheld at source
  payoutFees: string; // EUR decimal — platform cut charged at payout
}) {
  const t = useTranslations("fund.payments.settlement.deduction");
  const tRoot = useTranslations();
  const format = useFormatter();

  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(amount);
  const [note, setNote] = useState(comment ?? "");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setValue(amount);
      setNote(comment ?? "");
      setError(null);
    }
  }

  const euro = (v: string) =>
    format.number(Number(v), { style: "currency", currency: "EUR" });

  const amountNum = Number(value || "0");
  // Both fee figures are already out of the merchant's share, so the deduction
  // can only eat into what's left — mirrors the bound the action re-checks.
  const maxDeduction = maxManualDeductionCents({ total, fees, payoutFees });
  const valid =
    value.trim() !== "" &&
    Number.isFinite(amountNum) &&
    amountNum >= 0 &&
    toCents(value) <= maxDeduction;
  const projectedNet = valid
    ? payoutNet({ total, fees, payoutFees, manualDeduction: value })
    : null;
  const hasDeduction = Number(amount) > 0;

  const onConfirm = () => {
    setError(null);
    startTransition(async () => {
      const result = await setManualDeductionAction({
        payoutId,
        amount: value.trim() || "0",
        comment: note.trim() || null,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      // The Server Action revalidated the detail path AND called refresh(), so
      // the header net + this row re-render with the new figures — we just
      // close the dialog.
      onOpenChange(false);
    });
  };

  const onClear = () => {
    setError(null);
    startTransition(async () => {
      const result = await clearManualDeductionAction({ payoutId });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      onOpenChange(false);
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <Pencil className="size-4" />
            {hasDeduction ? t("edit") : t("trigger")}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor={`deduction-amount-${payoutId}`}>{t("amount")}</Label>
            <Input
              id={`deduction-amount-${payoutId}`}
              type="number"
              min="0"
              step="0.01"
              inputMode="decimal"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="0.00"
            />
            <p className="text-xs text-muted-foreground">
              {t("amountHint", { max: euro(fromCents(maxDeduction)) })}
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor={`deduction-comment-${payoutId}`}>
              {t("comment")}
            </Label>
            <Input
              id={`deduction-comment-${payoutId}`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t("commentPlaceholder")}
              autoComplete="off"
            />
          </div>

          {projectedNet !== null && (
            <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm">
              <span className="text-muted-foreground">{t("net")}</span>
              <span className="font-medium tabular-nums">
                {euro(projectedNet)}
              </span>
            </div>
          )}

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter className="flex-wrap">
          {hasDeduction && (
            <Button
              type="button"
              variant="ghost"
              className="mr-auto text-destructive hover:text-destructive"
              onClick={onClear}
              disabled={pending}
            >
              <Trash2 className="size-4" />
              {t("remove")}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            {tRoot("common.cancel")}
          </Button>
          <Button type="button" onClick={onConfirm} disabled={pending || !valid}>
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <CheckCircle2 className="size-4" />
            )}
            {t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
