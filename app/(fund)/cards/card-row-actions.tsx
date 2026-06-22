// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { Loader2, Search, X } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState, useTransition } from "react";

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
  listUnmatchedIncomingBankTransactionsAction,
  type PickableBankTransaction,
  setCardStatusAction,
  topUpCardAction,
  withdrawFromCardAction,
} from "@/services/card/admin-actions";
import { cn } from "@/lib/utils";

// Change status: set the card to ACTIVE / INACTIVE / BLOCKED directly, with an
// optional "reported lost" internal flag. Available on every card (it's the
// only path to activate an INACTIVE card or set one back to inactive).
// Top-up / withdraw available on ACTIVE cards with a CP-issued account.

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
  const canTransact = status === "ACTIVE" && hasAccount && tokenDecimals != null;
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
  const format = useFormatter();
  // The optional "attach a bank transfer" picker is a top-up-only affordance
  // (issue #28) — a withdraw never records an incoming deposit.
  const canAttach = kind === "topUp";
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // Bank-transfer attach state. Lazily loaded only while the picker is open so
  // a plain top-up doesn't pay for the deposit query.
  const [attachOpen, setAttachOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [txns, setTxns] = useState<PickableBankTransaction[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [selectedTx, setSelectedTx] = useState<PickableBankTransaction | null>(
    null,
  );
  const [loadingTxns, startLoadTxns] = useTransition();
  const [loadingMore, startLoadMore] = useTransition();

  function resetAttach() {
    setAttachOpen(false);
    setSearch("");
    setTxns(null);
    setNextCursor(null);
    setSelectedTx(null);
  }

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setAmount("");
      setError(null);
      setSuccess(null);
      resetAttach();
    }
  }

  // Load the first page when the picker opens, debounced on the search term.
  useEffect(() => {
    if (!open || !canAttach || !attachOpen) return;
    const handle = setTimeout(() => {
      startLoadTxns(async () => {
        const res = await listUnmatchedIncomingBankTransactionsAction({ search });
        if ("error" in res) {
          setTxns([]);
          setNextCursor(null);
          return;
        }
        setTxns(res.transactions);
        setNextCursor(res.nextCursor);
      });
    }, 200);
    return () => clearTimeout(handle);
  }, [open, canAttach, attachOpen, search]);

  function loadMore() {
    if (!nextCursor) return;
    startLoadMore(async () => {
      const res = await listUnmatchedIncomingBankTransactionsAction({
        search,
        cursor: nextCursor,
      });
      if ("error" in res) return;
      setTxns((prev) => [...(prev ?? []), ...res.transactions]);
      setNextCursor(res.nextCursor);
    });
  }

  function pickTransaction(tx: PickableBankTransaction) {
    setSelectedTx(tx);
    setAmount(tx.amount);
    setAttachOpen(false);
  }

  const onSubmit = () => {
    setError(null);
    startTransition(async () => {
      const result = await action({
        cardId,
        amount,
        ...(selectedTx ? { bankTransactionId: selectedTx.id } : {}),
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setSuccess(result.txHash);
    });
  };

  const money = (value: string, currency: string) =>
    format.number(Number(value), { style: "currency", currency });

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
          <div className="min-w-0 space-y-3">
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
            </div>

            {canAttach && (
              <BankTransferAttach
                selectedTx={selectedTx}
                attachOpen={attachOpen}
                onToggle={() => setAttachOpen((v) => !v)}
                onClear={() => setSelectedTx(null)}
                search={search}
                onSearch={setSearch}
                txns={txns}
                loadingTxns={loadingTxns}
                nextCursor={nextCursor}
                loadingMore={loadingMore}
                onPick={pickTransaction}
                onLoadMore={loadMore}
                money={money}
                formatDate={(iso) =>
                  format.dateTime(new Date(iso), { dateStyle: "medium" })
                }
              />
            )}

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

// Optional "attach a bank transfer" picker for the top-up dialog. Collapsed by
// default; once a deposit is picked it shows a compact summary and prefills the
// top-up amount. Mirrors the payout create-order picker's search + load-more.
function BankTransferAttach({
  selectedTx,
  attachOpen,
  onToggle,
  onClear,
  search,
  onSearch,
  txns,
  loadingTxns,
  nextCursor,
  loadingMore,
  onPick,
  onLoadMore,
  money,
  formatDate,
}: {
  selectedTx: PickableBankTransaction | null;
  attachOpen: boolean;
  onToggle: () => void;
  onClear: () => void;
  search: string;
  onSearch: (value: string) => void;
  txns: PickableBankTransaction[] | null;
  loadingTxns: boolean;
  nextCursor: string | null;
  loadingMore: boolean;
  onPick: (tx: PickableBankTransaction) => void;
  onLoadMore: () => void;
  money: (value: string, currency: string) => string;
  formatDate: (iso: string) => string;
}) {
  const t = useTranslations("cards.admin.topUp.attach");

  if (selectedTx) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs text-muted-foreground">{t("selected")}</div>
          <div className="truncate text-sm">
            {selectedTx.counterpartName ?? t("unknownCounterpart")}
            <span className="ml-2 font-medium tabular-nums">
              {money(selectedTx.amount, selectedTx.currency)}
            </span>
          </div>
          {selectedTx.reference && (
            <div className="truncate font-mono text-xs text-muted-foreground">
              {selectedTx.reference}
            </div>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={onClear}>
          <X className="size-4" />
          {t("clear")}
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <button
        type="button"
        aria-expanded={attachOpen}
        onClick={onToggle}
        className="text-sm font-medium text-muted-foreground hover:text-foreground"
      >
        {t("label")}
      </button>

      {attachOpen && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{t("hint")}</p>

          <div className="relative">
            <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => onSearch(e.target.value)}
              placeholder={t("searchPlaceholder")}
              autoComplete="off"
              className="pl-8"
            />
            {loadingTxns && (
              <Loader2 className="absolute top-1/2 right-2.5 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
            )}
          </div>

          {loadingTxns && txns === null ? (
            <div className="flex items-center justify-center gap-2 rounded-lg border border-border py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t("loading")}
            </div>
          ) : txns && txns.length > 0 ? (
            <div className="max-h-48 space-y-1 overflow-x-hidden overflow-y-auto rounded-lg border border-border p-1">
              {txns.map((tx) => (
                <button
                  key={tx.id}
                  type="button"
                  onClick={() => onPick(tx)}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-muted",
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm">
                      {tx.counterpartName ?? t("unknownCounterpart")}
                    </div>
                    <div className="truncate font-mono text-xs text-muted-foreground">
                      {tx.reference ?? "—"}
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="text-sm font-medium tabular-nums">
                      {money(tx.amount, tx.currency)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {formatDate(tx.occurredAt)}
                    </div>
                  </div>
                </button>
              ))}
              {nextCursor && (
                <button
                  type="button"
                  onClick={onLoadMore}
                  disabled={loadingMore}
                  className="flex w-full items-center justify-center gap-2 rounded-md px-2.5 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted disabled:opacity-60"
                >
                  {loadingMore && <Loader2 className="size-4 animate-spin" />}
                  {t("loadMore")}
                </button>
              )}
            </div>
          ) : (
            <div className="rounded-lg border border-border py-6 text-center text-sm text-muted-foreground">
              {search ? t("noMatches") : t("none")}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

