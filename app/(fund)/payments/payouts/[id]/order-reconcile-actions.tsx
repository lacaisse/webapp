// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowUpRight,
  Loader2,
  Trash2,
  Wrench,
} from "lucide-react";
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
import {
  archiveOrderAction,
  findOrderBankTransactionAction,
  fixOrderAction,
  getPayerAccountAction,
  type OrderBankMatch,
  type PayerTransfer,
} from "@/services/payout/admin-actions";
import { cn } from "@/lib/utils";

// Per-order reconciliation for a pending payout. Shown only on orders that
// aren't settled on-chain. "Fix" moves tokens with the fund's minter wallet
// (mint-to-place, or burn-from-payer + mint-to-place) and records the mint
// hash on the server; "Archive" drops the order from the payout.
export function OrderReconcileActions({
  payoutId,
  orderId,
  account,
  placeAccount,
  total,
  net,
  symbol,
  onReconciled,
}: {
  payoutId: string;
  orderId: number;
  account: string | null;
  placeAccount: string | null;
  total: string;
  net: string;
  symbol: string | null;
  // Fired once a fix/archive succeeds, so the parent can optimistically mark
  // the row "reconciling" until the server revalidation lands.
  onReconciled: () => void;
}) {
  return (
    <div className="flex items-center justify-end gap-1.5">
      <FixDialog
        payoutId={payoutId}
        orderId={orderId}
        account={account}
        placeAccount={placeAccount}
        total={total}
        net={net}
        symbol={symbol}
        onReconciled={onReconciled}
      />
      <ArchiveDialog
        payoutId={payoutId}
        orderId={orderId}
        onReconciled={onReconciled}
      />
    </div>
  );
}

function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

function FixDialog({
  payoutId,
  orderId,
  account,
  placeAccount,
  total,
  net,
  symbol,
  onReconciled,
}: {
  payoutId: string;
  orderId: number;
  account: string | null;
  placeAccount: string | null;
  total: string;
  net: string;
  symbol: string | null;
  onReconciled: () => void;
}) {
  const t = useTranslations("fund.payments.settlement.reconcile.fix");
  const tArchive = useTranslations("fund.payments.settlement.reconcile.archive");
  const tRoot = useTranslations();
  const format = useFormatter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [archiving, startArchive] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);

  // Payer account context (balance + recent transfers), loaded when the
  // dialog opens for a burn (there's a payer account).
  const [payerPending, startPayer] = useTransition();
  const [payer, setPayer] = useState<{
    balance: string | null;
    transfers: PayerTransfer[];
  } | null>(null);

  // No-account orders were paid by bank transfer; look up the matching
  // incoming transfer (reference `cp-order-{orderId}`) so the operator can
  // confirm the fiat landed before minting.
  const [bankPending, startBank] = useTransition();
  const [bankLoaded, setBankLoaded] = useState(false);
  const [bankMatch, setBankMatch] = useState<OrderBankMatch | null>(null);

  const fmt = (v: string) => (symbol ? `${v} ${symbol}` : v);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next && account && !payer && !payerPending) {
      startPayer(async () => {
        const result = await getPayerAccountAction({ account });
        if (!("error" in result)) {
          setPayer({ balance: result.balance, transfers: result.transfers });
        }
      });
    }
    if (next && !account && !bankLoaded && !bankPending) {
      startBank(async () => {
        const result = await findOrderBankTransactionAction({ orderId });
        if (!("error" in result)) setBankMatch(result.transaction);
        setBankLoaded(true);
      });
    }
    if (!next) {
      setError(null);
      setTxHash(null);
    }
  }

  const onConfirm = () => {
    setError(null);
    startTransition(async () => {
      const result = await fixOrderAction({
        payoutId,
        orderId,
        account,
        placeAccount,
        total,
        net,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setTxHash(result.txHash);
      onReconciled();
    });
  };

  const onArchive = () => {
    setError(null);
    startArchive(async () => {
      const result = await archiveOrderAction({ payoutId, orderId });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      onReconciled();
      onOpenChange(false);
    });
  };

  // The burn can't succeed if the payer no longer holds enough — block it
  // rather than letting an impossible reconciliation fail on-chain. The only
  // sensible action then is to archive the order, so we offer that instead.
  const insufficient =
    Boolean(account) &&
    payer?.balance != null &&
    Number(payer.balance) < Number(total);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <Wrench className="size-4" />
            {t("button")}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {account
              ? t("burnMint", {
                  total: fmt(total),
                  net: fmt(net),
                  account: shortAddr(account),
                })
              : t("mintOnly", { net: fmt(net) })}
          </DialogDescription>
        </DialogHeader>

        {account && (
          <div className="space-y-2 rounded-lg border border-border p-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {t("payerBalance")}
              </span>
              {payerPending ? (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              ) : payer?.balance != null ? (
                <span
                  className={cn(
                    "text-sm font-medium tabular-nums",
                    Number(payer.balance) >= Number(total)
                      ? "text-success"
                      : "text-warning",
                  )}
                >
                  {fmt(payer.balance)}
                </span>
              ) : (
                <span className="text-sm text-muted-foreground">—</span>
              )}
            </div>
            {payer && payer.transfers.length > 0 && (
              <ul className="space-y-0.5 border-t border-border pt-2">
                {payer.transfers.map((tx) => (
                  <li
                    key={tx.hash}
                    className="flex items-center justify-between gap-2 text-xs"
                  >
                    <span className="text-muted-foreground">
                      {tx.date
                        ? format.dateTime(new Date(tx.date), {
                            dateStyle: "medium",
                          })
                        : "—"}
                    </span>
                    <span className="inline-flex items-center gap-1 tabular-nums">
                      {tx.direction === "in" ? (
                        <ArrowDownLeft className="size-3 text-success" />
                      ) : (
                        <ArrowUpRight className="size-3 text-muted-foreground" />
                      )}
                      {fmt(tx.amount)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {payer && payer.transfers.length === 0 && !payerPending && (
              <p className="border-t border-border pt-2 text-xs text-muted-foreground">
                {t("payerNoHistory")}
              </p>
            )}
          </div>
        )}

        {!account && (
          <div className="space-y-2 overflow-hidden rounded-lg border border-border p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs text-muted-foreground">
                {t("bankMatch")}
              </span>
              {bankPending && (
                <Loader2 className="size-4 animate-spin text-muted-foreground" />
              )}
            </div>
            {bankMatch ? (
              <div className="space-y-0.5 border-t border-border pt-2">
                <div className="flex items-center justify-between gap-2 text-sm">
                  {/* min-w-0 lets the flex item shrink below content width so
                      the long bank reference truncates instead of pushing the
                      modal past its max-w-sm. */}
                  <div className="min-w-0 flex-1 truncate">
                    {bankMatch.counterpartName ?? t("bankMatchUnknown")}
                  </div>
                  <div className="shrink-0 font-medium tabular-nums">
                    {format.number(Number(bankMatch.amount), {
                      style: "currency",
                      currency: bankMatch.currency,
                    })}
                  </div>
                </div>
                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <div className="min-w-0 flex-1 truncate font-mono">
                    {bankMatch.reference ?? "—"}
                  </div>
                  <div className="shrink-0">
                    {format.dateTime(new Date(bankMatch.occurredAt), {
                      dateStyle: "medium",
                    })}
                  </div>
                </div>
              </div>
            ) : (
              bankLoaded && (
                <p className="border-t border-border pt-2 text-xs break-words text-muted-foreground">
                  {t("bankMatchNone", { ref: `cp-order-${orderId}` })}
                </p>
              )
            )}
          </div>
        )}

        {!placeAccount ? (
          <Alert variant="destructive">
            <AlertTriangle className="size-4" />
            <AlertDescription>{t("noPlaceAccount")}</AlertDescription>
          </Alert>
        ) : txHash ? (
          <div className="space-y-4">
            <Alert>
              <AlertDescription>
                <div>{t("success")}</div>
                <div className="mt-1 font-mono text-xs break-all">{txHash}</div>
              </AlertDescription>
            </Alert>
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
              >
                {tRoot("common.close")}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            <Alert variant="destructive">
              <AlertTriangle className="size-4" />
              <AlertDescription>
                {insufficient
                  ? t("insufficient", { total: fmt(total) })
                  : t("warning")}
              </AlertDescription>
            </Alert>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={pending || archiving}
              >
                {tRoot("common.cancel")}
              </Button>
              {insufficient ? (
                <Button
                  type="button"
                  variant="destructive"
                  onClick={onArchive}
                  disabled={archiving}
                >
                  {archiving ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Trash2 className="size-4" />
                  )}
                  {tArchive("confirm")}
                </Button>
              ) : (
                <Button type="button" onClick={onConfirm} disabled={pending}>
                  {pending && <Loader2 className="size-4 animate-spin" />}
                  {t("confirm")}
                </Button>
              )}
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ArchiveDialog({
  payoutId,
  orderId,
  onReconciled,
}: {
  payoutId: string;
  orderId: number;
  onReconciled: () => void;
}) {
  const t = useTranslations("fund.payments.settlement.reconcile.archive");
  const tRoot = useTranslations();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) setError(null);
  }

  const onConfirm = () => {
    setError(null);
    startTransition(async () => {
      const result = await archiveOrderAction({ payoutId, orderId });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      onReconciled();
      onOpenChange(false);
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button variant="ghost" size="sm">
            <Trash2 className="size-4" />
            {t("button")}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            {tRoot("common.cancel")}
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={onConfirm}
            disabled={pending}
          >
            {pending && <Loader2 className="size-4 animate-spin" />}
            {t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
