// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CheckCircle2,
  Loader2,
} from "lucide-react";
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
  accountBurnOutAction,
  accountMintInAction,
} from "@/services/token-account/admin-actions";

// `in` mints to the account, `out` burns from it — both via the minter key.
export function MoveTokensDialog({
  id,
  mode,
  symbol,
}: {
  id: string;
  mode: "in" | "out";
  symbol: string | null;
}) {
  const t = useTranslations("fund.accounts.move");
  const tRoot = useTranslations();
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  const Icon = mode === "in" ? ArrowDownToLine : ArrowUpFromLine;

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setAmount("");
      setError(null);
      setTxHash(null);
    }
  }

  const onSubmit = () => {
    setError(null);
    startTransition(async () => {
      const run = mode === "in" ? accountMintInAction : accountBurnOutAction;
      const result = await run({ id, amount: amount.trim() });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setTxHash(result.txHash);
    });
  };

  const valid = amount.trim() !== "" && Number(amount) > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <Icon className="size-4" />
            {mode === "in" ? t("inTrigger") : t("outTrigger")}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{mode === "in" ? t("inTitle") : t("outTitle")}</DialogTitle>
          <DialogDescription>
            {mode === "in" ? t("inDescription") : t("outDescription")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {txHash ? (
            <Alert>
              <CheckCircle2 className="size-4" />
              <AlertDescription>
                <div>{t("success")}</div>
                <div className="mt-1 font-mono text-xs break-all">{txHash}</div>
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor={`move-amount-${id}`}>
                  {t("amount")}
                  {symbol ? ` (${symbol})` : ""}
                </Label>
                <Input
                  id={`move-amount-${id}`}
                  type="number"
                  min="0"
                  step="any"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                />
              </div>
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
            </>
          )}
        </div>

        <DialogFooter>
          {txHash ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              {tRoot("common.close")}
            </Button>
          ) : (
            <>
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={pending}
              >
                {tRoot("common.cancel")}
              </Button>
              <Button type="button" onClick={onSubmit} disabled={pending || !valid}>
                {pending ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Icon className="size-4" />
                )}
                {t("confirm")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
