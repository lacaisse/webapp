// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { Loader2, Trash2, Wand2, X } from "lucide-react";
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
import {
  archiveOrdersAction,
  autoMatchPayerTransfersAction,
  planPlaceMintMatchesAction,
  recordOrderHashesAction,
} from "@/services/payout/admin-actions";
import type { AutoMatchStatus } from "@/services/payout/match";

// Orders processed per server round-trip. Small batches keep the progress bar
// moving and bound each request; the action also caches transfers per payer.
const CHUNK = 8;

// The order fields the bulk actions need. Kept minimal so the parent can pass a
// slice of its PayoutOrder rows.
export type BulkOrder = {
  id: number;
  account: string | null;
  total: string;
  net: string;
  completedAt: string | null;
  createdAt: string | null;
};

// Non-zero status counts, rendered as a per-order summary after a run.
type Summary = Partial<Record<AutoMatchStatus, number>> & {
  archived?: number;
  archiveFailed?: number;
  // Terminal orders left unchecked because the place transfer walk was capped.
  truncated?: number;
};

export function BulkIssueActions({
  payoutId,
  orders,
  onReconciled,
  onClear,
}: {
  payoutId: string;
  orders: BulkOrder[];
  // Fired per order once it's fixed/archived, so the parent can optimistically
  // mark the row "Reconciling…" until the server revalidation lands.
  onReconciled: (orderId: number) => void;
  onClear: () => void;
}) {
  const t = useTranslations("fund.payments.settlement.reconcile.bulk");
  const tRoot = useTranslations();

  const [matching, startMatch] = useTransition();
  const [archiving, startArchive] = useTransition();
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const [summary, setSummary] = useState<Summary | null>(null);
  const [archiveOpen, setArchiveOpen] = useState(false);

  const busy = matching || archiving;

  // Auto-match routes per order type: orders with a payer account match the
  // payer's outgoing transfer; terminal orders (no account) match the place's
  // incoming mint. Both record a real settlement hash — nothing moves on-chain.
  const onAutoMatch = () => {
    setSummary(null);
    const payerOrders = orders.filter((o) => o.account != null);
    const terminalOrders = orders.filter((o) => o.account == null);
    const total = orders.length;
    setProgress({ done: 0, total });
    startMatch(async () => {
      const counts: Summary = {};
      const add = (key: keyof Summary, n = 1) =>
        (counts[key] = (counts[key] ?? 0) + n);
      let done = 0;
      const bump = (n: number) => {
        done += n;
        setProgress({ done: Math.min(done, total), total });
      };

      // 1. Payer-account orders — per-order payer-transfer match, in batches.
      for (let i = 0; i < payerOrders.length; i += CHUNK) {
        const batch = payerOrders.slice(i, i + CHUNK);
        let results: { orderId: number; status: AutoMatchStatus }[] = [];
        try {
          const res = await autoMatchPayerTransfersAction({
            payoutId,
            orders: batch.map((o) => ({
              orderId: o.id,
              account: o.account,
              total: o.total,
              completedAt: o.completedAt,
            })),
          });
          results = res.results;
        } catch {
          results = batch.map((o) => ({ orderId: o.id, status: "error" as const }));
        }
        for (const r of results) {
          add(r.status);
          if (r.status === "fixed") onReconciled(r.orderId);
        }
        bump(batch.length);
      }

      // 2. Terminal orders — plan the place-mint matches in one pass (consume-once
      // is global), then record the resolved pairs in batches.
      if (terminalOrders.length > 0) {
        let plan;
        try {
          plan = await planPlaceMintMatchesAction({
            payoutId,
            orders: terminalOrders.map((o) => ({
              orderId: o.id,
              net: o.net,
              createdAt: o.createdAt,
              completedAt: o.completedAt,
            })),
          });
        } catch {
          plan = null;
        }
        if (!plan || plan.status !== "ok") {
          add("unavailable", terminalOrders.length);
          bump(terminalOrders.length);
        } else {
          // Unmatched: attribute to "truncated" when the walk was capped (their
          // mint may just not have been loaded), otherwise a genuine no-match.
          add(plan.truncated ? "truncated" : "nomatch", plan.unmatched.length);
          bump(plan.unmatched.length);
          for (let i = 0; i < plan.matched.length; i += CHUNK) {
            const batch = plan.matched.slice(i, i + CHUNK);
            let results: { orderId: number; ok: boolean }[] = [];
            try {
              const res = await recordOrderHashesAction({ payoutId, entries: batch });
              results = res.results;
            } catch {
              results = batch.map((e) => ({ orderId: e.orderId, ok: false }));
            }
            for (const r of results) {
              if (r.ok) {
                add("fixed");
                onReconciled(r.orderId);
              } else {
                add("error");
              }
            }
            bump(batch.length);
          }
        }
      }

      setProgress(null);
      setSummary(counts);
    });
  };

  const onArchive = () => {
    setSummary(null);
    startArchive(async () => {
      const res = await archiveOrdersAction({
        payoutId,
        orderIds: orders.map((o) => o.id),
      });
      let archived = 0;
      let archiveFailed = 0;
      for (const r of res.results) {
        if (r.ok) {
          archived += 1;
          onReconciled(r.orderId);
        } else {
          archiveFailed += 1;
        }
      }
      setArchiveOpen(false);
      setSummary({ archived, archiveFailed });
    });
  };

  const summaryEntries = summary
    ? (Object.entries(summary) as [keyof Summary, number][]).filter(
        ([, n]) => n > 0,
      )
    : [];

  return (
    <div className="space-y-2 rounded-lg border border-border bg-muted/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">
          {t("selectedCount", { n: orders.length })}
        </span>
        <div className="flex items-center gap-1.5">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={onAutoMatch}
            disabled={busy}
          >
            {matching ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Wand2 className="size-4" />
            )}
            {t("autoMatch")}
          </Button>

          <Dialog open={archiveOpen} onOpenChange={setArchiveOpen}>
            <DialogTrigger
              render={
                <Button variant="ghost" size="sm" disabled={busy}>
                  <Trash2 className="size-4" />
                  {t("archive")}
                </Button>
              }
            />
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t("archiveTitle")}</DialogTitle>
                <DialogDescription>
                  {t("archiveDescription", { n: orders.length })}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={() => setArchiveOpen(false)}
                  disabled={archiving}
                >
                  {tRoot("common.cancel")}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  onClick={onArchive}
                  disabled={archiving}
                >
                  {archiving && <Loader2 className="size-4 animate-spin" />}
                  {t("archiveConfirm")}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>

          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onClear}
            disabled={busy}
            aria-label={t("clear")}
          >
            <X className="size-4" />
            {t("clear")}
          </Button>
        </div>
      </div>

      {progress && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{t("running")}</span>
            <span className="tabular-nums">
              {progress.done} / {progress.total}
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all duration-300"
              style={{
                width: `${
                  progress.total > 0
                    ? Math.round((progress.done / progress.total) * 100)
                    : 0
                }%`,
              }}
            />
          </div>
        </div>
      )}

      {summary && summaryEntries.length > 0 && (
        <Alert>
          <AlertDescription>
            <ul className="space-y-0.5 text-sm">
              {summaryEntries.map(([key, n]) => (
                <li key={key}>{t(`summary.${key}` as never, { n } as never)}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
