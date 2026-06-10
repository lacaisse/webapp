// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { CheckCircle2, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
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
import { runFullBankSyncChunkAction } from "@/services/bank/admin-actions";

type Totals = {
  ingested: number;
  matched: number;
  skipped: number;
};
const ZERO: Totals = { ingested: 0, matched: 0, skipped: 0 };
type Phase = "idle" | "running" | "paused" | "done" | "error";

// Safety bound for a single run. End-of-history is `done` from the server
// (no next cursor / empty page); this only trips if the feed keeps handing
// back pages far past any plausible history. Resuming starts a fresh run, so a
// genuinely huge history can still complete across resumes — this just caps one
// uninterrupted stretch. A non-advancing cursor is caught separately below.
const MAX_PAGES_PER_RUN = 1000;

// Manual full bank-sync. The whole history can be tens of thousands of rows, so
// we drive it page-by-page from the client (one short server-action call each)
// rather than one long request: progress is visible as it runs, and reaching
// the last page is the unambiguous "done" signal. Re-pulls are idempotent, so
// Stop + Resume (or an outright restart) is safe.
export function BankFullSync({ connected }: { connected: boolean }) {
  const t = useTranslations("fund.bank.fullSync");
  // `refresh` from next/cache is server-action-only — in a client component
  // the router API is the way to re-render the page's server components.
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [totals, setTotals] = useState<Totals>(ZERO);
  const [pages, setPages] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Cursor to (re)start from; `undefined` means "from the newest page".
  const resumeCursor = useRef<string | undefined>(undefined);
  const abort = useRef(false);

  async function runLoop(fresh: boolean) {
    if (fresh) {
      setTotals(ZERO);
      setPages(0);
      resumeCursor.current = undefined;
    }
    const acc: Totals = fresh ? { ...ZERO } : { ...totals };
    let cursor = resumeCursor.current;
    let pageCount = fresh ? 0 : pages;
    let pagesThisRun = 0;
    let refreshed = false;
    abort.current = false;
    setError(null);
    setPhase("running");

    for (;;) {
      const sentCursor = cursor;
      const res = await runFullBankSyncChunkAction({ cursor });
      if ("error" in res) {
        resumeCursor.current = cursor; // resume retries the page that failed
        setError(res.error);
        setPhase("error");
        return;
      }
      acc.ingested += res.stats.ingested;
      acc.matched += res.stats.matched;
      acc.skipped += res.stats.skipped;
      pageCount += 1;
      pagesThisRun += 1;
      setTotals({ ...acc });
      setPages(pageCount);

      if (res.done) {
        resumeCursor.current = undefined;
        router.refresh(); // final consistency pass
        setPhase("done");
        return;
      }

      // Guard: the feed handed back the same cursor it received, so paging on
      // would refetch the same page forever. Stop instead of looping.
      if (res.nextCursor !== null && res.nextCursor === sentCursor) {
        resumeCursor.current = sentCursor; // resume retries in case it was transient
        setError(t("stalled"));
        setPhase("error");
        return;
      }

      // The feed is newest-first, so the rows the table shows (newest page)
      // land in the first chunk. Refresh once then so they appear mid-sync;
      // later chunks only add older rows that aren't on the visible page.
      if (!refreshed) {
        refreshed = true;
        router.refresh();
      }
      cursor = res.nextCursor ?? undefined;

      // Guard: don't page forever in one run. Resume picks up from here.
      if (pagesThisRun >= MAX_PAGES_PER_RUN) {
        resumeCursor.current = cursor;
        setError(t("limitReached"));
        setPhase("error");
        return;
      }

      if (abort.current) {
        resumeCursor.current = cursor; // resume continues from the next page
        router.refresh();
        setPhase("paused");
        return;
      }
    }
  }

  if (!connected) return null;

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
            <RefreshCw className="size-4" />
            {t("resume")}
          </Button>
        ) : (
          <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
            <DialogTrigger render={<Button variant="outline" size="sm" />}>
              <RefreshCw className="size-4" />
              {t("trigger")}
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>{t("confirmTitle")}</DialogTitle>
                <DialogDescription>{t("confirmDescription")}</DialogDescription>
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

        {(running || pages > 0) && (
          <span className="text-xs text-muted-foreground tabular-nums">
            {t("progress", {
              ingested: totals.ingested,
              matched: totals.matched,
              skipped: totals.skipped,
            })}
            {" · "}
            {t("pages", { pages })}
          </span>
        )}
      </div>

      {phase === "done" && (
        <Alert>
          <CheckCircle2 className="size-4 text-success" />
          <AlertTitle>{t("completeTitle")}</AlertTitle>
          <AlertDescription>
            {t("completeSummary", {
              ingested: totals.ingested,
              matched: totals.matched,
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
