// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { CheckCircle2, Loader2, Send } from "lucide-react";
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
import { accountTransferAction } from "@/services/token-account/admin-actions";

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;

type AccountOption = { id: string; name: string; address: string };

// Send the fund token from this account to another address — pick one of the
// fund's other accounts, or paste any wallet address.
export function TransferDialog({
  id,
  accounts,
  symbol,
}: {
  id: string;
  accounts: AccountOption[];
  symbol: string | null;
}) {
  const t = useTranslations("fund.accounts.transfer");
  const tRoot = useTranslations();
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setTo("");
      setAmount("");
      setError(null);
      setTxHash(null);
    }
  }

  const onSubmit = () => {
    setError(null);
    startTransition(async () => {
      const result = await accountTransferAction({
        id,
        to: to.trim(),
        amount: amount.trim(),
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setTxHash(result.txHash);
    });
  };

  const validTo = ADDRESS.test(to.trim());
  const valid = validTo && amount.trim() !== "" && Number(amount) > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <Send className="size-4" />
            {t("trigger")}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
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
                <Label htmlFor={`transfer-to-${id}`}>{t("destination")}</Label>
                {accounts.length > 0 && (
                  <select
                    aria-label={t("pickAccount")}
                    value={accounts.some((a) => a.address === to) ? to : ""}
                    onChange={(e) => e.target.value && setTo(e.target.value)}
                    className="h-8 w-full rounded-md bg-background px-2 text-sm ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option value="">{t("pickAccount")}</option>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.address}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                )}
                <Input
                  id={`transfer-to-${id}`}
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  placeholder="0x…"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono text-xs"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor={`transfer-amount-${id}`}>
                  {t("amount")}
                  {symbol ? ` (${symbol})` : ""}
                </Label>
                <Input
                  id={`transfer-amount-${id}`}
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
                  <Send className="size-4" />
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
