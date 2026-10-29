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
import { ProposeTransferSchema, type TransferToken } from "@/services/safe/schemas";

import { sameAddress } from "../format";
import { useStepUp } from "../reauth-dialog";
import { ProposalResult } from "./proposal-result";

type RecipientOption = {
  address: string;
  label: string;
  kind: "ACCOUNT" | "CARD";
};

// One balance the Safe can send: the fund token (first, the default) or a
// display token the fund shows (xDAI / EURe / a custom ERC-20). `balance` is
// the human amount on the Safe, null when the read failed.
export type TransferTokenOption = {
  key: TransferToken;
  symbol: string | null;
  balance: string | null;
};

const SELECT_CLASS =
  "h-8 w-full rounded-md bg-background px-2 text-sm ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring";

// Propose sending one of the Safe's balances out — the fund token by default,
// or a display token the fund shows (xDAI / EURe / custom; picker hidden
// when there is none). Pick one of the fund's accounts / staff cards, or paste any address.
// The proposal then collects signatures; it executes as soon as the
// threshold is met.
export function ProposeTransferDialog({
  safeId,
  chainId,
  threshold,
  options,
  tokens,
  hasPasskey,
}: {
  safeId: string;
  chainId: number;
  threshold: number;
  options: RecipientOption[];
  tokens: TransferTokenOption[];
  hasPasskey: boolean;
}) {
  const t = useTranslations("fund.safes.transfer");
  const tRoot = useTranslations();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [tokenKey, setTokenKey] = useState<TransferToken>(tokens[0]?.key ?? "fund");
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    executed: boolean;
    txHash: string | null;
  } | null>(null);
  const stepUp = useStepUp(hasPasskey);

  const picked = options.find((o) => sameAddress(o.address, to.trim()));
  const token = tokens.find((tok) => tok.key === tokenKey) ?? tokens[0];
  const symbol = token?.symbol ?? null;
  const accounts = options.filter((o) => o.kind === "ACCOUNT");
  const cards = options.filter((o) => o.kind === "CARD");

  function onOpenChange(next: boolean) {
    if (pending || stepUp.pending) return;
    setOpen(next);
    if (!next) {
      setTo("");
      setAmount("");
      setTokenKey(tokens[0]?.key ?? "fund");
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
      token: token?.key ?? "fund",
      recipientLabel: picked?.label,
      note: note.trim() === "" ? undefined : note,
    });
    if (!parsed.success) {
      setError(tRoot(parsed.error.issues[0]!.message as never));
      return;
    }
    startTransition(async () => {
      const res = await proposeTransferAction(parsed.data);
      // Not fresh enough: confirm identity, then the same submit again.
      if (stepUp.check(res, onSubmit)) return;
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

              {tokens.length > 1 && (
                <div className="space-y-2">
                  <Label htmlFor={`safe-transfer-token-${safeId}`}>{t("token")}</Label>
                  <select
                    id={`safe-transfer-token-${safeId}`}
                    value={token?.key ?? "fund"}
                    onChange={(e) => setTokenKey(e.target.value as TransferToken)}
                    className={SELECT_CLASS}
                  >
                    {tokens.map((tok) => (
                      <option key={tok.key} value={tok.key}>
                        {`${tok.symbol ?? t("token")} · ${tok.balance ?? "—"}`}
                      </option>
                    ))}
                  </select>
                </div>
              )}

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
        {stepUp.dialog}
      </DialogContent>
    </Dialog>
  );
}
