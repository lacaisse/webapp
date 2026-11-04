// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { Loader2, Repeat } from "lucide-react";
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
import { prepareQuoteAction, quoteConversionAction, startConversionAction } from "@/services/convert/admin-actions";
import { relayQuote } from "@/services/convert/browser-quote";
import type { ConversionQuote } from "@/services/convert/engine";
import { DEFAULT_SLIPPAGE_BPS, QuoteConversionSchema } from "@/services/convert/schemas";
import type { PreparedHttp } from "@/services/convert/types";
import type { SigningPasskeyHandle } from "@/services/safe/action-types";

import { useStepUp } from "@/components/reauth-dialog";
import { useProposeAndSign, type ProposalOutcome } from "../passkey-hooks";
import { ProposalResult } from "./proposal-result";

// One conversion the fund is offered on this Safe (services/convert/registry
// offeredPairs): the converter and the two display tokens it joins.
export type ConvertPairOption = {
  converterId: string;
  from: { symbol: string; balance: string | null }; // balance: human amount on the Safe
  to: { symbol: string };
};

const SELECT_CLASS =
  "h-8 w-full rounded-md bg-background px-2 text-sm ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring";

// Swap one of the Safe's balances for another (EURe ↔ BREAD) through a CoW
// order the Safe pre-signs. Quote first — expected, minimum, how many Safe
// transactions — then propose: the first transaction collects signatures
// like a transfer; the engine takes it from there (services/convert).
//
// The quote's outside call is made from THIS browser: the server prepares
// the request, the browser fetches it, the server parses the answer
// (services/convert/browser-quote.ts says why). Propose fetches a fresh one
// the same way, so the order is posted on a price seconds old.
export function ConvertDialog({
  safeId,
  chainId,
  threshold,
  pairs,
  hasPasskey,
  me,
}: {
  safeId: string;
  chainId: number;
  threshold: number;
  pairs: ConvertPairOption[];
  hasPasskey: boolean;
  me: SigningPasskeyHandle | null;
}) {
  const t = useTranslations("fund.safes.conversion");
  const tRoot = useTranslations();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [converterId, setConverterId] = useState(pairs[0]?.converterId ?? "");
  const [amount, setAmount] = useState("");
  const [quote, setQuote] = useState<ConversionQuote | null>(null);
  // The quote request as the server prepared it, kept for the fresh quote at
  // propose time; null when the quote calls nothing outside.
  const [prepared, setPrepared] = useState<PreparedHttp | null>(null);
  const [quoting, startQuoting] = useTransition();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProposalOutcome | null>(null);
  const stepUp = useStepUp(hasPasskey);
  const { finish } = useProposeAndSign(safeId, me);

  const pair = pairs.find((p) => p.converterId === converterId) ?? pairs[0];

  function reset() {
    setConverterId(pairs[0]?.converterId ?? "");
    setAmount("");
    setQuote(null);
    setPrepared(null);
    setError(null);
  }

  function onOpenChange(next: boolean) {
    if (pending || quoting || stepUp.pending) return;
    setOpen(next);
    if (!next) {
      reset();
      if (result) router.refresh();
      setResult(null);
    }
  }

  // Any change to what is converted invalidates the quote and its request.
  const onAmount = (v: string) => {
    setAmount(v);
    setQuote(null);
    setPrepared(null);
  };
  const onPair = (v: string) => {
    setConverterId(v);
    setQuote(null);
    setPrepared(null);
  };

  const parsedInput = () =>
    QuoteConversionSchema.safeParse({
      safeId,
      converterId: pair?.converterId,
      amount,
      slippageBps: DEFAULT_SLIPPAGE_BPS,
    });

  const onQuote = () => {
    setError(null);
    const parsed = parsedInput();
    if (!parsed.success) {
      setError(tRoot(parsed.error.issues[0]!.message as never));
      return;
    }
    startQuoting(async () => {
      const prep = await prepareQuoteAction(parsed.data);
      if ("error" in prep) {
        setError(prep.error);
        return;
      }
      // A browser that cannot reach the orderbook sends no answer: the
      // server then calls out itself.
      const relayed = prep.request ? await relayQuote(prep.request) : null;
      const res = await quoteConversionAction({ ...parsed.data, ...(relayed ? { relayed } : {}) });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setPrepared(prep.request);
      setQuote(res.quote);
    });
  };

  const onSubmit = () => {
    if (!quote) return;
    setError(null);
    startTransition(async () => {
      const relayed = prepared ? await relayQuote(prepared) : null;
      const res = await startConversionAction({
        safeId,
        converterId: quote.converterId,
        amount,
        minOut: quote.minOut,
        slippageBps: quote.slippageBps,
        ...(relayed ? { relayed } : {}),
      });
      // Not fresh enough: confirm identity, then the same submit again.
      if (stepUp.check(res, onSubmit)) return;
      router.refresh();
      if ("error" in res) {
        setError(res.error);
        setQuote(null); // the market may have moved: quote again
        return;
      }
      // A passkey owner signs their own proposal right away (one more tap).
      const outcome = await finish(res);
      router.refresh();
      setResult(outcome);
    });
  };

  const validAmount = amount.trim() !== "" && Number(amount) > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button size="sm" variant="outline">
            <Repeat className="size-4" />
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
              unsigned={result.unsigned}
              error={result.error}
            />
          ) : (
            <>
              {pairs.length > 1 && (
                <div className="space-y-2">
                  <Label htmlFor={`safe-convert-pair-${safeId}`}>{t("pair")}</Label>
                  <select
                    id={`safe-convert-pair-${safeId}`}
                    value={pair?.converterId ?? ""}
                    onChange={(e) => onPair(e.target.value)}
                    className={SELECT_CLASS}
                    disabled={pending || quoting}
                  >
                    {pairs.map((p) => (
                      <option key={p.converterId} value={p.converterId}>
                        {t("pairOption", { from: p.from.symbol, to: p.to.symbol })}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="space-y-2">
                <Label htmlFor={`safe-convert-amount-${safeId}`}>
                  {t("amount")}
                  {pair ? ` (${pair.from.symbol})` : ""}
                </Label>
                <Input
                  id={`safe-convert-amount-${safeId}`}
                  type="number"
                  min="0"
                  step="any"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => onAmount(e.target.value)}
                  placeholder="0.00"
                  disabled={pending || quoting}
                />
                {pair?.from.balance != null && (
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {t("balance", { balance: pair.from.balance, symbol: pair.from.symbol })}
                  </p>
                )}
              </div>

              {quote ? (
                <div className="space-y-1.5 rounded-lg bg-muted/40 px-3 py-2 text-sm">
                  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                    <dt className="text-muted-foreground">{t("quote.expected")}</dt>
                    <dd className="font-medium tabular-nums">{`${quote.to.expected} ${quote.to.symbol}`}</dd>
                    <dt className="text-muted-foreground">
                      {t("quote.minimum", { slippage: `${quote.slippageBps / 100} %` })}
                    </dt>
                    <dd className="font-medium tabular-nums">{`${quote.to.min} ${quote.to.symbol}`}</dd>
                    <dt className="text-muted-foreground">{t("quote.rate")}</dt>
                    <dd className="tabular-nums">{`1 ${quote.from.symbol} ≈ ${quote.rate} ${quote.to.symbol}`}</dd>
                  </dl>
                  {quote.cost && (
                    <p className="text-xs text-muted-foreground">
                      {quote.cost.feePercent === "0"
                        ? t("quote.costTiny")
                        : t("quote.cost", { percent: quote.cost.feePercent })}
                      {quote.cost.fee !== "0" &&
                        t("quote.costAmount", { amount: quote.cost.fee, symbol: quote.from.symbol })}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">{t("quote.validity")}</p>
                  <p className="text-xs text-muted-foreground">
                    {quote.rounds > 1 ? t("quote.roundsTwo") : t("quote.roundsOne")}
                  </p>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="outline"
                  onClick={onQuote}
                  disabled={quoting || pending || !validAmount || !pair}
                >
                  {quoting ? <Loader2 className="size-4 animate-spin" /> : <Repeat className="size-4" />}
                  {t("getQuote")}
                </Button>
              )}

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
                disabled={pending || quoting}
              >
                {tRoot("common.cancel")}
              </Button>
              {quote && (
                <Button type="button" variant="ghost" onClick={onQuote} disabled={pending || quoting}>
                  {t("requote")}
                </Button>
              )}
              <Button type="button" onClick={onSubmit} disabled={pending || quoting || !quote}>
                {pending ? <Loader2 className="size-4 animate-spin" /> : <Repeat className="size-4" />}
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
