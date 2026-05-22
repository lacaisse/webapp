// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { AlertTriangle, CheckCircle2, Loader2, RefreshCw } from "lucide-react";
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
import { cn } from "@/lib/utils";
import {
  importOneCardAction,
  previewCardSyncAction,
  pushOneCardAction,
  pushOneCardStatusAction,
  revalidateCardsAfterSyncAction,
  type CardSyncItemResult,
  type CardSyncPlanWire,
} from "@/services/card/admin-actions";

// All three per-item actions share the same { ok | error } shape; alias
// the type so the runStep helper can be generic over the execute fn.
type CardSyncItemResultLike = CardSyncItemResult;

// Three-step sync UX, driven client-side so we can render real progress:
//   1. import   — pull CP-only cards into local
//   2. status   — push local status to CP for mismatches
//   3. push     — push local-only cards to CP
//
// The preview action returns the full plan (item lists, not just counts).
// On confirm, the client iterates each step's items sequentially and
// updates per-step state after every per-item server-action round-trip.
// One revalidatePath at the end refreshes the /cards table.

type StepKey = "import" | "status" | "push";

type StepState = {
  total: number;
  done: number;
  errors: number;
  // "pending" before this step starts, "running" while items resolve,
  // "complete" once every item has been attempted.
  phase: "pending" | "running" | "complete";
};

type DialogState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "preview"; plan: CardSyncPlanWire }
  | { kind: "error"; message: string }
  | {
      kind: "running" | "done";
      steps: Record<StepKey, StepState>;
    };

function emptySteps(plan: CardSyncPlanWire): Record<StepKey, StepState> {
  return {
    import: { total: plan.import.length, done: 0, errors: 0, phase: "pending" },
    status: {
      total: plan.statusUpdate.length,
      done: 0,
      errors: 0,
      phase: "pending",
    },
    push: { total: plan.push.length, done: 0, errors: 0, phase: "pending" },
  };
}

export function CardSyncDialog() {
  const t = useTranslations("cards.admin.sync");
  const tRoot = useTranslations();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<DialogState>({ kind: "idle" });
  // We use startTransition for the preview fetch so the dialog renders
  // its loading state cleanly; the per-item run uses raw async work so
  // we can sequence state updates explicitly.
  const [previewPending, startPreviewTransition] = useTransition();

  function onOpenChange(next: boolean) {
    // Don't let the user dismiss the dialog mid-run — closing would leave
    // partial work without a way to see what got done. Final state is
    // safe to close from.
    if (!next && state.kind === "running") return;
    setOpen(next);
    if (!next) {
      setState({ kind: "idle" });
      return;
    }
    setState({ kind: "loading" });
    startPreviewTransition(async () => {
      const result = await previewCardSyncAction();
      if ("error" in result) {
        setState({ kind: "error", message: result.error });
      } else {
        setState({ kind: "preview", plan: result.plan });
      }
    });
  }

  async function run(plan: CardSyncPlanWire) {
    setState({ kind: "running", steps: emptySteps(plan) });

    // Functional state updater: reads the latest steps from prev so we
    // don't have to keep a parallel mutable copy. React 18 flushes
    // between await boundaries, so each iteration's update lands in the
    // UI before the next item starts.
    function updateStep(
      key: StepKey,
      mut: (s: StepState) => StepState,
    ): void {
      setState((prev) => {
        if (prev.kind !== "running") return prev;
        return {
          kind: "running",
          steps: { ...prev.steps, [key]: mut(prev.steps[key]) },
        };
      });
    }

    async function runStep<T>(
      key: StepKey,
      items: T[],
      execute: (item: T) => Promise<CardSyncItemResultLike>,
    ) {
      updateStep(key, (s) => ({
        ...s,
        phase: items.length === 0 ? "complete" : "running",
      }));
      for (const item of items) {
        const r = await execute(item);
        updateStep(key, (s) => ({
          ...s,
          done: s.done + 1,
          errors: s.errors + ("error" in r ? 1 : 0),
        }));
      }
      updateStep(key, (s) => ({ ...s, phase: "complete" }));
    }

    await runStep("import", plan.import, (i) =>
      importOneCardAction({ serialNumber: i.serialNumber }),
    );
    await runStep("status", plan.statusUpdate, (i) =>
      pushOneCardStatusAction({ cardId: i.cardId }),
    );
    await runStep("push", plan.push, (i) =>
      pushOneCardAction({ cardId: i.cardId }),
    );

    // One revalidate at the end refreshes the /cards table behind us.
    await revalidateCardsAfterSyncAction();

    setState((prev) =>
      prev.kind === "running" ? { kind: "done", steps: prev.steps } : prev,
    );
  }

  const planTotal =
    state.kind === "preview"
      ? state.plan.import.length +
        state.plan.statusUpdate.length +
        state.plan.push.length
      : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button variant="outline">
            <RefreshCw className="size-4" />
            {t("trigger")}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        {state.kind === "loading" && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {t("loadingPreview")}
          </div>
        )}

        {state.kind === "error" && (
          <Alert variant="destructive">
            <AlertDescription>{state.message}</AlertDescription>
          </Alert>
        )}

        {state.kind === "preview" && (
          <div className="space-y-2">
            {planTotal === 0 ? (
              <Alert>
                <CheckCircle2 className="size-4" />
                <AlertDescription>{t("nothingToSync")}</AlertDescription>
              </Alert>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {state.plan.import.length > 0 && (
                  <SummaryRow
                    label={t("summary.import", {
                      count: state.plan.import.length,
                    })}
                  />
                )}
                {state.plan.statusUpdate.length > 0 && (
                  <SummaryRow
                    label={t("summary.statusUpdate", {
                      count: state.plan.statusUpdate.length,
                    })}
                  />
                )}
                {state.plan.push.length > 0 && (
                  <SummaryRow
                    label={t("summary.push", {
                      count: state.plan.push.length,
                    })}
                  />
                )}
              </ul>
            )}
          </div>
        )}

        {(state.kind === "running" || state.kind === "done") && (
          <div className="space-y-3">
            <StepRow stepKey="import" step={state.steps.import} t={t} />
            <StepRow stepKey="status" step={state.steps.status} t={t} />
            <StepRow stepKey="push" step={state.steps.push} t={t} />
          </div>
        )}

        <DialogFooter>
          {state.kind === "preview" && planTotal > 0 && (
            <>
              <Button
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={previewPending}
              >
                {tRoot("common.cancel")}
              </Button>
              <Button onClick={() => run(state.plan)}>{t("confirm")}</Button>
            </>
          )}
          {(state.kind === "done" ||
            (state.kind === "preview" && planTotal === 0) ||
            state.kind === "error") && (
            <Button onClick={() => onOpenChange(false)}>
              {tRoot("common.close")}
            </Button>
          )}
          {state.kind === "running" && (
            <Button disabled>
              <Loader2 className="size-4 animate-spin" />
              {t("running")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SummaryRow({ label }: { label: string }) {
  return (
    <li className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2">
      <span className="size-1.5 rounded-full bg-primary" />
      {label}
    </li>
  );
}

function StepRow({
  stepKey,
  step,
  t,
}: {
  stepKey: StepKey;
  step: StepState;
  t: ReturnType<typeof useTranslations>;
}) {
  // Hide step rows that had nothing to do AND are not the current step.
  // Keeps the dialog from showing three near-empty rows when only one
  // category had drift.
  if (step.total === 0) return null;

  const pct = step.total === 0 ? 100 : Math.round((step.done / step.total) * 100);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2 text-sm">
        <div className="flex items-center gap-2">
          <StepIcon phase={step.phase} hasErrors={step.errors > 0} />
          <span>{t(`steps.${stepKey}`)}</span>
        </div>
        <span className="tabular-nums text-xs text-muted-foreground">
          {step.done} / {step.total}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full transition-all duration-150",
            step.errors > 0 ? "bg-warning" : "bg-primary",
          )}
          style={{ width: `${pct}%` }}
        />
      </div>
      {step.errors > 0 && step.phase === "complete" && (
        <p className="text-xs text-warning">
          {t("errorsInStep", { count: step.errors })}
        </p>
      )}
    </div>
  );
}

function StepIcon({
  phase,
  hasErrors,
}: {
  phase: StepState["phase"];
  hasErrors: boolean;
}) {
  if (phase === "running") {
    return <Loader2 className="size-3.5 animate-spin text-primary" />;
  }
  if (phase === "complete") {
    if (hasErrors) {
      return <AlertTriangle className="size-3.5 text-warning" />;
    }
    return <CheckCircle2 className="size-3.5 text-primary" />;
  }
  // pending — a small empty circle so the row sits visually before its turn
  return <span className="size-3.5 rounded-full border border-muted-foreground/30" />;
}
