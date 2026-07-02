// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import {
  AlertTriangle,
  CheckCircle2,
  ListPlus,
  Loader2,
  Search,
} from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
import type { PayoutOrder } from "@/services/citizenpay/types";
import {
  addOrdersAction,
  previewAddableOrdersAction,
  type PreviewAddableOrdersResult,
} from "@/services/payout/admin-actions";
import { cn } from "@/lib/utils";

type PreviewOk = Extract<PreviewAddableOrdersResult, { ok: true }>;

// Pull existing, already-settled orders into a pending payout — for orders that
// arrived late or fell outside the payout's original date range. Preview over a
// [from, to] window, deselect any the operator doesn't want, then add the rest.
// It's all-or-nothing on CP's side: a stale selection fails 422 with per-order
// reasons, which we surface before re-previewing from a fresh list.
export function AddOrdersDialog({ payoutId }: { payoutId: string }) {
  const t = useTranslations("fund.payments.settlement.addOrders");
  const tRoot = useTranslations();
  const format = useFormatter();

  const [open, setOpen] = useState(false);
  const defaults = lastMonthRange();
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);

  // Accumulated preview: orders grow as the operator loads more pages; every
  // row is checked by default, so we track the *deselected* set instead.
  const [orders, setOrders] = useState<PayoutOrder[]>([]);
  const [summary, setSummary] = useState<PreviewOk["summary"] | null>(null);
  const [total, setTotal] = useState(0);
  const [deselected, setDeselected] = useState<Set<number>>(new Set());
  const [previewed, setPreviewed] = useState(false);

  const [previewing, startPreview] = useTransition();
  const [loadingMore, startLoadMore] = useTransition();
  const [adding, startAdd] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Populated on a 422 (some selected orders went stale) — shown until the next
  // preview clears it.
  const [rejected, setRejected] = useState<
    { id: number; reason: string }[] | null
  >(null);
  const [done, setDone] = useState<{ assigned: number } | null>(null);

  function reset() {
    const d = lastMonthRange();
    setFrom(d.from);
    setTo(d.to);
    setOrders([]);
    setSummary(null);
    setTotal(0);
    setDeselected(new Set());
    setPreviewed(false);
    setError(null);
    setRejected(null);
    setDone(null);
  }

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) reset();
  }

  // Editing either bound invalidates the loaded candidates — clear them so the
  // operator re-previews against the new window.
  function onRange(setter: (v: string) => void) {
    return (v: string) => {
      setter(v);
      setOrders([]);
      setSummary(null);
      setTotal(0);
      setDeselected(new Set());
      setPreviewed(false);
      setError(null);
    };
  }

  const runPreview = () => {
    setError(null);
    startPreview(async () => {
      const res = await previewAddableOrdersAction({
        payoutId,
        from,
        to,
        offset: 0,
      });
      if ("error" in res) {
        setError(res.error);
        setOrders([]);
        setSummary(null);
        setTotal(0);
        setPreviewed(true);
        return;
      }
      setOrders(res.orders);
      setSummary(res.summary);
      setTotal(res.total);
      setDeselected(new Set());
      setPreviewed(true);
    });
  };

  const loadMore = () => {
    startLoadMore(async () => {
      const res = await previewAddableOrdersAction({
        payoutId,
        from,
        to,
        offset: orders.length,
      });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      // Guard against duplicates if the window shifted between pages.
      setOrders((prev) => {
        const seen = new Set(prev.map((o) => o.id));
        return [...prev, ...res.orders.filter((o) => !seen.has(o.id))];
      });
      setTotal(res.total);
    });
  };

  function toggle(id: number, checked: boolean) {
    setDeselected((prev) => {
      const next = new Set(prev);
      if (checked) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const selectedIds = orders
    .filter((o) => !deselected.has(o.id))
    .map((o) => o.id);

  const onAdd = () => {
    if (selectedIds.length === 0) return;
    setError(null);
    setRejected(null);
    startAdd(async () => {
      const res = await addOrdersAction({ payoutId, orderIds: selectedIds });
      if ("ok" in res) {
        setDone({ assigned: res.assigned });
        return;
      }
      // A 422 carries the per-order reasons: show them, drop those rows, then
      // re-preview so the operator works from a fresh list.
      if ("rejected" in res && res.rejected.length > 0) {
        setRejected(res.rejected);
        runPreview();
        return;
      }
      setError(res.error);
    });
  };

  const euro = (v: string) =>
    format.number(Number(v), { style: "currency", currency: "EUR" });

  const hasMore = orders.length < total;
  const busy = previewing || adding;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <ListPlus className="size-4" />
            {t("trigger")}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        {/* min-w-0: grid item of DialogContent — let it shrink so long rows
            truncate instead of forcing the dialog past its max width. */}
        <div className="min-w-0 space-y-4">
          {done ? (
            <Alert>
              <CheckCircle2 className="size-4" />
              <AlertDescription>
                {t("success", { count: done.assigned })}
              </AlertDescription>
            </Alert>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-2">
                  <Label htmlFor={`add-from-${payoutId}`}>{t("from")}</Label>
                  <Input
                    id={`add-from-${payoutId}`}
                    type="date"
                    value={from}
                    onChange={(e) => onRange(setFrom)(e.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor={`add-to-${payoutId}`}>{t("to")}</Label>
                  <Input
                    id={`add-to-${payoutId}`}
                    type="date"
                    value={to}
                    onChange={(e) => onRange(setTo)(e.target.value)}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">{t("rangeHint")}</p>

              {rejected && (
                <Alert variant="warning">
                  <AlertTriangle className="size-4" />
                  <AlertDescription>
                    <div>{t("rejectedTitle")}</div>
                    <ul className="mt-1 space-y-0.5 text-xs">
                      {rejected.map((r) => (
                        <li key={r.id} className="break-words">
                          <span className="font-mono">#{r.id}</span>
                          {r.reason ? ` — ${r.reason}` : null}
                        </li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}

              {summary && summary.orderCount > 0 && (
                <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm">
                  <span className="text-muted-foreground">
                    {t("windowSummary", { count: summary.orderCount })}
                  </span>
                  <span className="font-medium tabular-nums">
                    {euro(summary.net)}
                  </span>
                </div>
              )}

              {previewed && orders.length > 0 && (
                <div className="max-h-56 space-y-1 overflow-x-hidden overflow-y-auto rounded-lg border border-border p-1">
                  {orders.map((o) => {
                    const checked = !deselected.has(o.id);
                    return (
                      <label
                        key={o.id}
                        className={cn(
                          "flex cursor-pointer items-center gap-3 rounded-md px-2.5 py-2 transition-colors",
                          checked ? "bg-primary/5" : "hover:bg-muted",
                        )}
                      >
                        <Checkbox
                          checked={checked}
                          onCheckedChange={(v) => toggle(o.id, Boolean(v))}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 text-sm">
                            <span className="font-mono text-xs text-muted-foreground">
                              #{o.id}
                            </span>
                            <Badge variant="outline" className="capitalize">
                              {o.status}
                            </Badge>
                          </div>
                          <div className="truncate text-xs text-muted-foreground">
                            {o.description ??
                              (o.completedAt
                                ? format.dateTime(new Date(o.completedAt), {
                                    dateStyle: "medium",
                                  })
                                : "—")}
                          </div>
                        </div>
                        <div className="shrink-0 text-right">
                          <div className="text-sm font-medium tabular-nums">
                            {euro(o.total)}
                          </div>
                          <div className="text-xs text-muted-foreground tabular-nums">
                            {t("net")}: {euro(o.net)}
                          </div>
                        </div>
                      </label>
                    );
                  })}
                  {hasMore && (
                    <button
                      type="button"
                      onClick={loadMore}
                      disabled={loadingMore}
                      className="flex w-full items-center justify-center gap-2 rounded-md px-2.5 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted disabled:opacity-60"
                    >
                      {loadingMore && <Loader2 className="size-4 animate-spin" />}
                      {t("loadMore")}
                    </button>
                  )}
                </div>
              )}

              {previewed &&
                orders.length === 0 &&
                !previewing &&
                !error && (
                  <div className="flex items-center justify-center gap-2 rounded-lg border border-border py-6 text-sm text-muted-foreground">
                    <Search className="size-4" />
                    {t("empty")}
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
                disabled={busy}
              >
                {tRoot("common.cancel")}
              </Button>
              {previewed && orders.length > 0 ? (
                <Button
                  type="button"
                  onClick={onAdd}
                  disabled={busy || selectedIds.length === 0}
                >
                  {adding ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <CheckCircle2 className="size-4" />
                  )}
                  {t("confirm", { count: selectedIds.length })}
                </Button>
              ) : (
                <Button type="button" onClick={runPreview} disabled={busy}>
                  {previewing ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Search className="size-4" />
                  )}
                  {t("preview")}
                </Button>
              )}
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Default to the previous calendar month as a [from, to) range — the common
// "orders I forgot from last month" case. Local time is fine; the action
// widens these date-only strings to UTC midnight.
function lastMonthRange(): { from: string; to: string } {
  const now = new Date();
  const firstThis = new Date(now.getFullYear(), now.getMonth(), 1);
  const firstLast = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  return { from: iso(firstLast), to: iso(firstThis) };
}

function iso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
