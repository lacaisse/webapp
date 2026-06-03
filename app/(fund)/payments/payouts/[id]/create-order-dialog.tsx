// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { CheckCircle2, Loader2, Plus } from "lucide-react";
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
  createPayoutOrderAction,
  listIncomingBankTransactionsAction,
  type PickableBankTransaction,
} from "@/services/payout/admin-actions";
import { cn } from "@/lib/utils";

type Mode = "manual" | "bank";

// Add an order to a pending payout by hand. Two ways to fill the same three
// fields (amount / fee / description): type them directly, or pick an incoming
// bank transaction — which prefills the amount and drops its reference into the
// description. The amounts stay editable either way; the server re-validates.
export function CreateOrderDialog({ payoutId }: { payoutId: string }) {
  const t = useTranslations("fund.payments.settlement.createOrder");
  const tRoot = useTranslations();
  const format = useFormatter();

  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("manual");

  const [total, setTotal] = useState("");
  const [fees, setFees] = useState("0");
  const [description, setDescription] = useState("");
  const [selectedTxId, setSelectedTxId] = useState<string | null>(null);

  const [txns, setTxns] = useState<PickableBankTransaction[] | null>(null);
  const [loadingTxns, startLoadTxns] = useTransition();
  const [creating, startCreate] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setMode("manual");
    setTotal("");
    setFees("0");
    setDescription("");
    setSelectedTxId(null);
    setError(null);
  }

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) reset();
  }

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
    // Lazy-load the transaction list the first time the operator opens the
    // bank tab — it's a DB read we don't want on every payout-detail render.
    if (next === "bank" && txns === null && !loadingTxns) {
      startLoadTxns(async () => {
        const res = await listIncomingBankTransactionsAction();
        setTxns("error" in res ? [] : res.transactions);
      });
    }
  }

  function pickTransaction(tx: PickableBankTransaction) {
    setSelectedTxId(tx.id);
    setTotal(tx.amount);
    setDescription(tx.reference ?? "");
  }

  const onCreate = () => {
    setError(null);
    startCreate(async () => {
      const result = await createPayoutOrderAction({
        payoutId,
        total: total.trim(),
        fees: fees.trim() || "0",
        description: description.trim() || null,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      onOpenChange(false);
    });
  };

  const euro = (v: string) =>
    format.number(Number(v), { style: "currency", currency: "EUR" });

  const totalNum = Number(total);
  const feesNum = Number(fees || "0");
  const netValid =
    total.trim() !== "" &&
    Number.isFinite(totalNum) &&
    totalNum > 0 &&
    Number.isFinite(feesNum) &&
    feesNum >= 0 &&
    feesNum <= totalNum;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <Plus className="size-4" />
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
          {/* Mode toggle */}
          <div className="inline-flex w-full items-center gap-0.5 rounded-lg bg-muted p-0.5 text-sm">
            <ModeButton
              active={mode === "manual"}
              onClick={() => switchMode("manual")}
            >
              {t("modeManual")}
            </ModeButton>
            <ModeButton
              active={mode === "bank"}
              onClick={() => switchMode("bank")}
            >
              {t("modeBank")}
            </ModeButton>
          </div>

          {mode === "bank" && (
            <div className="space-y-2">
              <p className="text-xs text-muted-foreground">{t("pickHint")}</p>
              {loadingTxns ? (
                <div className="flex items-center justify-center gap-2 rounded-lg border border-border py-6 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  {t("loadingTransactions")}
                </div>
              ) : txns && txns.length > 0 ? (
                <div className="max-h-48 space-y-1 overflow-x-hidden overflow-y-auto rounded-lg border border-border p-1">
                  {txns.map((tx) => (
                    <button
                      key={tx.id}
                      type="button"
                      onClick={() => pickTransaction(tx)}
                      className={cn(
                        "flex w-full items-center justify-between gap-3 rounded-md px-2.5 py-2 text-left transition-colors",
                        selectedTxId === tx.id
                          ? "bg-primary/10 ring-1 ring-primary/30"
                          : "hover:bg-muted",
                      )}
                    >
                      {/* min-w-0 lets the flex item shrink below content width
                          so the long bank reference truncates instead of
                          pushing the whole dialog wider than its max-w-sm. */}
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
                          {euro(tx.amount)}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {format.dateTime(new Date(tx.occurredAt), {
                            dateStyle: "medium",
                          })}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="rounded-lg border border-border py-6 text-center text-sm text-muted-foreground">
                  {t("noTransactions")}
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor={`order-total-${payoutId}`}>{t("amount")}</Label>
              <Input
                id={`order-total-${payoutId}`}
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                value={total}
                onChange={(e) => setTotal(e.target.value)}
                placeholder="0.00"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`order-fees-${payoutId}`}>{t("fee")}</Label>
              <Input
                id={`order-fees-${payoutId}`}
                type="number"
                min="0"
                step="0.01"
                inputMode="decimal"
                value={fees}
                onChange={(e) => setFees(e.target.value)}
                placeholder="0.00"
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor={`order-desc-${payoutId}`}>
              {t("descriptionLabel")}
            </Label>
            <Input
              id={`order-desc-${payoutId}`}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("descriptionPlaceholder")}
              autoComplete="off"
            />
          </div>

          {netValid && (
            <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm">
              <span className="text-muted-foreground">{t("net")}</span>
              <span className="font-medium tabular-nums">
                {euro((totalNum - feesNum).toFixed(2))}
              </span>
            </div>
          )}

          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={creating}
          >
            {tRoot("common.cancel")}
          </Button>
          <Button
            type="button"
            onClick={onCreate}
            disabled={creating || !netValid}
          >
            {creating ? (
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

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        "inline-flex h-8 flex-1 items-center justify-center rounded-md px-3 font-medium transition-colors",
        active
          ? "bg-background text-foreground shadow-sm ring-1 ring-foreground/10"
          : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
