// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { CheckCircle2, Coins, Loader2, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { runPeriodAllocationChunkAction } from "@/services/allocation-periods/run-actions";

type Totals = {
  minted: number;
  submitted: number;
  failed: number;
  skipped: number;
};
const ZERO: Totals = { minted: 0, submitted: 0, failed: 0, skipped: 0 };
type Phase = "idle" | "running" | "paused" | "done" | "error";

// Bulk allocation run for one period, driven chunk-by-chunk from the client
// (one small server-action call per batch of members) so a big run shows
// progress as it mints and can be stopped between batches. The server skips
// members already allocated for the period, so Stop + Resume (or a fresh
// restart) never double-mints.
export function RunAllocation({
  periodId,
  readyCount,
  totalAmount,
}: {
  periodId: string;
  // How many members qualify right now (for the confirm copy + progress
  // denominator). Snapshot at page render.
  readyCount: number;
  totalAmount: string;
}) {
  const t = useTranslations("fund.allocations.periodDetail.run");
  // `refresh` from next/cache is server-action-only — in a client component
  // the router API is the way to re-render the page's server components.
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [totals, setTotals] = useState<Totals>(ZERO);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Cursor to (re)start from; `undefined` means "from the first member".
  const resumeCursor = useRef<string | undefined>(undefined);
  const abort = useRef(false);

  async function runLoop(fresh: boolean) {
    if (fresh) {
      setTotals(ZERO);
      resumeCursor.current = undefined;
    }
    const acc: Totals = fresh ? { ...ZERO } : { ...totals };
    let cursor = resumeCursor.current;
    abort.current = false;
    setError(null);
    setPhase("running");

    for (;;) {
      const res = await runPeriodAllocationChunkAction({ periodId, cursor });
      if ("error" in res) {
        resumeCursor.current = cursor; // resume retries the chunk that failed
        setError(res.error);
        setPhase("error");
        return;
      }
      acc.minted += res.stats.minted;
      acc.submitted += res.stats.submitted;
      acc.failed += res.stats.failed;
      acc.skipped += res.stats.skipped;
      setTotals({ ...acc });

      if (res.done) {
        resumeCursor.current = undefined;
        router.refresh();
        setPhase("done");
        return;
      }
      // Member-id cursor is strictly increasing, so every chunk advances —
      // no stall guard needed (unlike the bank feed's opaque cursor).
      cursor = res.nextCursor ?? undefined;

      if (abort.current) {
        resumeCursor.current = cursor; // resume continues from the next chunk
        router.refresh();
        setPhase("paused");
        return;
      }
    }
  }

  const running = phase === "running";

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        {running ? (
          <>
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              <span>{t("running")}</span>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                abort.current = true;
              }}
            >
              {t("stop")}
            </Button>
          </>
        ) : phase === "error" || phase === "paused" ? (
          <Button type="button" size="sm" onClick={() => void runLoop(false)}>
            <Coins className="size-4" />
            {t("resume")}
          </Button>
        ) : (
          <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
            <DialogTrigger
              render={<Button size="sm" disabled={readyCount === 0} />}
            >
              <Coins className="size-4" />
              {t("trigger", { count: readyCount })}
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t("confirmTitle")}</DialogTitle>
                <DialogDescription>
                  {t("confirmDescription", {
                    count: readyCount,
                    total: totalAmount,
                  })}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <DialogClose
                  render={<Button type="button" variant="outline" />}
                >
                  {t("confirmCancel")}
                </DialogClose>
                <Button
                  type="button"
                  onClick={() => {
                    setConfirmOpen(false);
                    void runLoop(true);
                  }}
                >
                  {t("confirmRun")}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        )}

        {(running || totals.minted > 0 || totals.submitted > 0) && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {t("progress", {
              minted: totals.minted,
              total: readyCount,
              submitted: totals.submitted,
            })}
          </span>
        )}
      </div>

      {phase === "done" && (
        <Alert>
          <CheckCircle2 className="size-4 text-success" />
          <AlertTitle>{t("completeTitle")}</AlertTitle>
          <AlertDescription>
            {t("completeSummary", {
              minted: totals.minted,
              submitted: totals.submitted,
              failed: totals.failed,
              skipped: totals.skipped,
            })}
          </AlertDescription>
        </Alert>
      )}

      {phase === "error" && error && (
        <Alert variant="destructive">
          <TriangleAlert className="size-4" />
          <AlertTitle>{t("errorTitle")}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}
