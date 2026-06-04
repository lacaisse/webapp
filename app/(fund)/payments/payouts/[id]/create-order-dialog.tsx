// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { AlertTriangle, CheckCircle2, Loader2, Plus, Search } from "lucide-react";
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

  const [search, setSearch] = useState("");
  const [txns, setTxns] = useState<PickableBankTransaction[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loadingTxns, startLoadTxns] = useTransition();
  const [loadingMore, startLoadMore] = useTransition();
  const [creating, startCreate] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Outcome of a successful create: the order always lands; minting may or may
  // not have. Drives the confirmation/warning state (and stops a second
  // submit creating a duplicate order).
  const [done, setDone] = useState<
    { kind: "minted"; txHash: string } | { kind: "mintFailed"; message: string } | null
  >(null);

  function reset() {
    setMode("manual");
    setTotal("");
    setFees("0");
    setDescription("");
    setSelectedTxId(null);
    setSearch("");
    setTxns(null);
    setNextCursor(null);
    setError(null);
    setDone(null);
  }

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) reset();
  }

  function switchMode(next: Mode) {
    setMode(next);
    setError(null);
  }

  // Load the first page whenever the bank tab is open, debounced on the search
  // term so each keystroke doesn't fire a query. The DB read is lazy (only
  // while the bank tab is active) — we don't want it on every payout render.
  useEffect(() => {
    if (!open || mode !== "bank") return;
    const handle = setTimeout(() => {
      startLoadTxns(async () => {
        const res = await listIncomingBankTransactionsAction({ search });
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
  }, [open, mode, search]);

  function loadMore() {
    if (!nextCursor) return;
    startLoadMore(async () => {
      const res = await listIncomingBankTransactionsAction({
        search,
        cursor: nextCursor,
      });
      if ("error" in res) return;
      setTxns((prev) => [...(prev ?? []), ...res.transactions]);
      setNextCursor(res.nextCursor);
    });
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
      // Only a pre-create failure is a retryable error. Once the order exists
      // the result is always ok — minted or with a mintError to surface.
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setDone(
        "txHash" in result
          ? { kind: "minted", txHash: result.txHash }
          : { kind: "mintFailed", message: result.mintError },
      );
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

        {/* min-w-0: this is a grid item of DialogContent (display:grid). Grid
            items default to min-width:auto and won't shrink below their
            content's intrinsic width — the long, unbreakable bank-transfer
            references would otherwise force the track wider than the dialog's
            max-w-sm, defeating the per-row `truncate` and painting past the
            card's edge. Allowing it to shrink lets truncation kick in. */}
        <div className="min-w-0 space-y-4">
          {done ? (
            done.kind === "minted" ? (
              <Alert>
                <CheckCircle2 className="size-4" />
                <AlertDescription>
                  <div>{t("successMinted")}</div>
                  <div className="mt-1 font-mono text-xs break-all">
                    {done.txHash}
                  </div>
                </AlertDescription>
              </Alert>
            ) : (
              <Alert variant="warning">
                <AlertTriangle className="size-4" />
                <AlertDescription>
                  <div>{t("mintFailed")}</div>
                  <div className="mt-1 text-xs break-words opacity-90">
                    {done.message}
                  </div>
                </AlertDescription>
              </Alert>
            )
          ) : (
            <>
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

              <div className="relative">
                <Search className="absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
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
                  {nextCursor && (
                    <button
                      type="button"
                      onClick={loadMore}
                      disabled={loadingMore}
                      className="flex w-full items-center justify-center gap-2 rounded-md px-2.5 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted disabled:opacity-60"
                    >
                      {loadingMore && (
                        <Loader2 className="size-4 animate-spin" />
                      )}
                      {t("loadMore")}
                    </button>
                  )}
                </div>
              ) : (
                <div className="rounded-lg border border-border py-6 text-center text-sm text-muted-foreground">
                  {search ? t("noMatches") : t("noTransactions")}
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
            </>
          )}
        </div>

        <DialogFooter>
          {done ? (
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
            </>
          )}
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
