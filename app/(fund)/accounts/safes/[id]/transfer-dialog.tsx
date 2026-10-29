// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { Loader2, Send } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { proposeTransferAction } from "@/services/safe/admin-actions";
import { ProposeTransferSchema } from "@/services/safe/schemas";

import { sameAddress } from "../format";
import { ProposalResult } from "./proposal-result";

type RecipientOption = {
  address: string;
  label: string;
  kind: "ACCOUNT" | "CARD";
};

const SELECT_CLASS =
  "h-8 w-full rounded-md bg-background px-2 text-sm ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring";

// Propose sending the fund token out of the Safe. Pick one of the fund's
// accounts / staff cards, or paste any address. The proposal then collects
// signatures; it executes as soon as the threshold is met.
export function ProposeTransferDialog({
  safeId,
  chainId,
  threshold,
  options,
  symbol,
}: {
  safeId: string;
  chainId: number;
  threshold: number;
  options: RecipientOption[];
  symbol: string | null;
}) {
  const t = useTranslations("fund.safes.transfer");
  const tRoot = useTranslations();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    executed: boolean;
    txHash: string | null;
  } | null>(null);

  const picked = options.find((o) => sameAddress(o.address, to.trim()));
  const accounts = options.filter((o) => o.kind === "ACCOUNT");
  const cards = options.filter((o) => o.kind === "CARD");

  function onOpenChange(next: boolean) {
    if (pending) return;
    setOpen(next);
    if (!next) {
      setTo("");
      setAmount("");
      setNote("");
      setError(null);
      if (result) router.refresh();
      setResult(null);
    }
  }

  const onSubmit = () => {
    setError(null);
    const parsed = ProposeTransferSchema.safeParse({
      safeId,
      recipient: to,
      amount,
      recipientLabel: picked?.label,
      note: note.trim() === "" ? undefined : note,
    });
    if (!parsed.success) {
      setError(tRoot(parsed.error.issues[0]!.message as never));
      return;
    }
    startTransition(async () => {
      const res = await proposeTransferAction(parsed.data);
      // Refresh on errors too: the proposal may exist and be marked FAILED
      // (execution reverted), and should show up in the pending list.
      router.refresh();
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setResult({ executed: res.executed, txHash: res.txHash });
    });
  };

  const valid = to.trim() !== "" && amount.trim() !== "" && Number(amount) > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button size="sm">
            <Send className="size-4" />
            {t("trigger")}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description", { threshold })}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {result ? (
            <ProposalResult
              chainId={chainId}
              executed={result.executed}
              txHash={result.txHash}
              threshold={threshold}
            />
          ) : (
            <>
              <div className="space-y-2">
                <Label htmlFor={`safe-transfer-to-${safeId}`}>{t("recipient")}</Label>
                {options.length > 0 && (
                  <select
                    aria-label={t("pickRecipient")}
                    value={picked?.address ?? ""}
                    onChange={(e) => e.target.value && setTo(e.target.value)}
                    className={SELECT_CLASS}
                  >
                    <option value="">{t("pickRecipient")}</option>
                    {accounts.length > 0 && (
                      <optgroup label={t("groupAccounts")}>
                        {accounts.map((o) => (
                          <option key={o.address} value={o.address}>
                            {o.label}
                          </option>
                        ))}
                      </optgroup>
                    )}
                    {cards.length > 0 && (
                      <optgroup label={t("groupCards")}>
                        {cards.map((o) => (
                          <option key={o.address} value={o.address}>
                            {o.label}
                          </option>
                        ))}
                      </optgroup>
                    )}
                  </select>
                )}
                <Input
                  id={`safe-transfer-to-${safeId}`}
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  placeholder="0x…"
                  autoComplete="off"
                  spellCheck={false}
                  className="font-mono text-xs"
                />
                {picked && (
                  <p className="text-xs text-muted-foreground">
                    {t("recipientIs", { label: picked.label })}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label htmlFor={`safe-transfer-amount-${safeId}`}>
                  {t("amount")}
                  {symbol ? ` (${symbol})` : ""}
                </Label>
                <Input
                  id={`safe-transfer-amount-${safeId}`}
                  type="number"
                  min="0"
                  step="any"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor={`safe-transfer-note-${safeId}`}>{t("note")}</Label>
                <Input
                  id={`safe-transfer-note-${safeId}`}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={t("notePlaceholder")}
                  autoComplete="off"
                  maxLength={200}
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
          {result ? (
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
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
