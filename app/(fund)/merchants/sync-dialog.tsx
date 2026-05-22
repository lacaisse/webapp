// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Loader2,
  Plus,
  RefreshCw,
  Unlink2,
} from "lucide-react";
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
  createMerchantFromPlaceAction,
  linkPlaceToMerchantAction,
  type MerchantSyncItemResult,
  type MerchantSyncPlanWire,
  previewMerchantSyncAction,
  revalidateMerchantsAfterSyncAction,
  unlinkStaleMerchantAction,
} from "@/services/merchant/admin-actions";

// Right-side sheet (centred dialog re-anchored via className overrides —
// no dedicated Sheet primitive in components/ui yet). Gives us full
// viewport height so the three action lists can scroll independently of
// the header/footer.
//
// Three-step run on confirm, mirroring /cards/sync-dialog.tsx but
// adapted to the merchant model:
//   1. link    — claim an unconnected local Merchant for a CP place
//                that matches by exact (case-insensitive) name
//   2. create  — for CP places with no local match, spin up a new
//                Merchant from the CP profile
//   3. unlink  — clear CP linkage on local Merchants whose placeId is
//                no longer reported by CP
//
// Per-item server actions return { ok | error } so the dialog can keep
// running and surface failure counts at the end.

type StepKey = "link" | "create" | "unlink";

type StepState = {
  total: number;
  done: number;
  errors: number;
  phase: "pending" | "running" | "complete";
};

type DialogState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "preview"; plan: MerchantSyncPlanWire }
  | { kind: "error"; message: string }
  | {
      kind: "running" | "done";
      steps: Record<StepKey, StepState>;
    };

function emptySteps(plan: MerchantSyncPlanWire): Record<StepKey, StepState> {
  return {
    link: { total: plan.autoLinks.length, done: 0, errors: 0, phase: "pending" },
    create: {
      total: plan.unlinkedPlaces.length,
      done: 0,
      errors: 0,
      phase: "pending",
    },
    unlink: {
      total: plan.stalePlaces.length,
      done: 0,
      errors: 0,
      phase: "pending",
    },
  };
}

export function MerchantSyncDialog() {
  const t = useTranslations("merchants.admin.sync");
  const tRoot = useTranslations();
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<DialogState>({ kind: "idle" });
  const [previewPending, startPreviewTransition] = useTransition();

  function onOpenChange(next: boolean) {
    if (!next && state.kind === "running") return;
    setOpen(next);
    if (!next) {
      setState({ kind: "idle" });
      return;
    }
    setState({ kind: "loading" });
    startPreviewTransition(async () => {
      const result = await previewMerchantSyncAction();
      if ("error" in result) {
        setState({ kind: "error", message: result.error });
      } else {
        setState({ kind: "preview", plan: result.plan });
      }
    });
  }

  async function run(plan: MerchantSyncPlanWire) {
    setState({ kind: "running", steps: emptySteps(plan) });

    function updateStep(key: StepKey, mut: (s: StepState) => StepState): void {
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
      execute: (item: T) => Promise<MerchantSyncItemResult>,
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

    await runStep("link", plan.autoLinks, (a) =>
      linkPlaceToMerchantAction({
        placeId: a.placeId,
        merchantId: a.merchantId,
      }),
    );
    await runStep("create", plan.unlinkedPlaces, (p) =>
      createMerchantFromPlaceAction({ placeId: p.placeId }),
    );
    await runStep("unlink", plan.stalePlaces, (s) =>
      unlinkStaleMerchantAction({ merchantId: s.merchantId }),
    );

    await revalidateMerchantsAfterSyncAction();
    setState((prev) =>
      prev.kind === "running" ? { kind: "done", steps: prev.steps } : prev,
    );
  }

  const planTotal =
    state.kind === "preview"
      ? state.plan.autoLinks.length +
        state.plan.unlinkedPlaces.length +
        state.plan.stalePlaces.length
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
      <DialogContent
        // Re-anchor: full-height sheet sliding in from the right.
        // Overrides the centred-popup defaults from components/ui/dialog.
        className={cn(
          "top-0 right-0 left-auto h-screen w-full max-w-[28rem] translate-x-0 translate-y-0",
          "rounded-none rounded-l-xl",
          "grid-rows-[auto_1fr_auto] gap-0 p-0",
          "data-open:animate-in data-open:slide-in-from-right",
          "data-closed:animate-out data-closed:slide-out-to-right",
          "data-open:fade-in-100 data-closed:fade-out-100",
        )}
      >
        <DialogHeader className="border-b p-4">
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        <div className="overflow-y-auto p-4">
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
            <PreviewBody plan={state.plan} planTotal={planTotal} />
          )}

          {(state.kind === "running" || state.kind === "done") && (
            <div className="space-y-3">
              <StepRow stepKey="link" step={state.steps.link} t={t} />
              <StepRow stepKey="create" step={state.steps.create} t={t} />
              <StepRow stepKey="unlink" step={state.steps.unlink} t={t} />
            </div>
          )}
        </div>

        <DialogFooter className="m-0 rounded-none border-t">
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

function PreviewBody({
  plan,
  planTotal,
}: {
  plan: MerchantSyncPlanWire;
  planTotal: number;
}) {
  const t = useTranslations("merchants.admin.sync");
  if (planTotal === 0) {
    return (
      <Alert>
        <CheckCircle2 className="size-4" />
        <AlertDescription>
          {t("nothingToSync", { count: plan.connectedCount })}
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-5">
      {plan.connectedCount > 0 && (
        <p className="text-xs text-muted-foreground">
          {t("summary.connected", { count: plan.connectedCount })}
        </p>
      )}

      {plan.autoLinks.length > 0 && (
        <Section
          title={t("sections.link", { count: plan.autoLinks.length })}
          help={t("sections.linkHelp")}
        >
          {plan.autoLinks.map((a) => (
            <li
              key={a.placeId}
              className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm"
            >
              <ArrowRight className="size-3.5 shrink-0 text-primary" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{a.placeName}</div>
                <div className="truncate text-xs text-muted-foreground">
                  {t("sections.linkRowSubtitle", { merchant: a.merchantName })}
                </div>
              </div>
            </li>
          ))}
        </Section>
      )}

      {plan.unlinkedPlaces.length > 0 && (
        <Section
          title={t("sections.create", { count: plan.unlinkedPlaces.length })}
          help={t("sections.createHelp")}
        >
          {plan.unlinkedPlaces.map((p) => (
            <li
              key={p.placeId}
              className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm"
            >
              <Plus className="size-3.5 shrink-0 text-primary" />
              <span className="truncate font-medium">{p.name}</span>
            </li>
          ))}
        </Section>
      )}

      {plan.stalePlaces.length > 0 && (
        <Section
          title={t("sections.unlink", { count: plan.stalePlaces.length })}
          help={t("sections.unlinkHelp")}
        >
          {plan.stalePlaces.map((s) => (
            <li
              key={s.merchantId}
              className="flex items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm"
            >
              <Unlink2 className="size-3.5 shrink-0 text-warning" />
              <span className="truncate font-medium">{s.merchantName}</span>
            </li>
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({
  title,
  help,
  children,
}: {
  title: string;
  help: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <h3 className="text-sm font-medium">{title}</h3>
      <p className="text-xs text-muted-foreground">{help}</p>
      <ul className="space-y-1.5">{children}</ul>
    </section>
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
  if (step.total === 0) return null;
  const pct = Math.round((step.done / step.total) * 100);
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
  return (
    <span className="size-3.5 rounded-full border border-muted-foreground/30" />
  );
}
