// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { Fragment, useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Coins,
  ExternalLink,
  Flame,
  Info,
  Loader2,
  RefreshCw,
  Unlock,
} from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
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
import type { PayoutStatus } from "@/services/citizenpay/types";
import type { BurnAttempt } from "@/services/payout/burn-claim-config";
import {
  burnPayoutAction,
  completePayoutAction,
  createPayoutPaymentAction,
  feeTransferAction,
  getPayoutStatusAction,
  pollPayoutStatusAction,
  recordPayoutBurnAction,
  releasePayoutBurnClaimAction,
} from "@/services/payout/admin-actions";
import { TX_HASH } from "@/services/payout/schemas";
import { cn } from "@/lib/utils";

// How often to poll for signing completion while the QR is on screen (only
// while the tab is focused).
const POLL_INTERVAL_MS = 5000;

// The settlement lifecycle, in order. CP's `payment-pending` is shown as
// "Awaiting signature" since that's what the treasury is waiting on.
const STEPS: { status: PayoutStatus; key: string }[] = [
  { status: "pending", key: "pending" },
  { status: "burnt", key: "burnt" },
  { status: "payment-pending", key: "awaitingSignature" },
  { status: "complete", key: "complete" },
];

// An in-flight burn claim as the page hands it down: the start time is
// pre-formatted server-side so server and client render the same string.
export type BurnClaimView = {
  // Pins the forced release to the claim this page showed.
  claimId: string | null;
  startedAt: string;
  // When CP will accept a forced release (claim + 10 min); 0 = unknown, let
  // the server decide.
  releasableAtMs: number;
  releasableAtLabel: string;
  // What we know locally about the attempt behind the claim (null: nothing
  // found, or the lookup failed).
  attempt: BurnAttempt | null;
};

// Guided "Process payout" card: a stepper showing where the payout is, plus
// the single contextual action for the current stage. Drives the admin
// burn → pay → sign → complete rather than showing every button at once.
export function PayoutProcess({
  payoutId,
  status,
  canInitiatePayment,
  signingUrl,
  signingQr,
  feeTransferPending,
  burnClaim,
}: {
  payoutId: string;
  status: PayoutStatus;
  // Whether the treasury's bank connection has payment initiation enabled —
  // a prerequisite for the "Pay merchant" → "Awaiting signature" step.
  canInitiatePayment: boolean;
  // Live Ponto signing link + its QR (from /status), present while
  // payment-pending. Null otherwise.
  signingUrl: string | null;
  signingQr: string | null;
  // True when the payout is burned but the retained cut hasn't been swept yet
  // — drives a persistent "Transfer fees" retry affordance.
  feeTransferPending: boolean;
  // A burn attempt took CP's claim and nothing is recorded yet — it may still
  // be running or it was interrupted. Replaces the Burn button with the
  // record / release panel so no second burn can start from here.
  burnClaim: BurnClaimView | null;
}) {
  const t = useTranslations("fund.payments.settlement.process");
  const tFee = useTranslations("fund.payments.settlement.feeTransfer");

  return (
    <section className="space-y-4 rounded-lg border border-border p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">{t("title")}</h2>
        <RefreshStatus payoutId={payoutId} />
      </div>

      <Stepper status={status} />

      <div className="border-t border-border pt-4">
        {status === "pending" &&
          (burnClaim ? (
            <BurnClaimPanel payoutId={payoutId} claim={burnClaim} />
          ) : (
            <ActionRow hint={t("burn.hint")}>
              <BurnDialog payoutId={payoutId} />
            </ActionRow>
          ))}
        {status === "burnt" &&
          (canInitiatePayment ? (
            <SignPayment
              payoutId={payoutId}
              stage="burnt"
              signingUrl={signingUrl}
              signingQr={signingQr}
            />
          ) : (
            <Alert>
              <Info className="size-4" />
              <AlertDescription>
                {t("pay.notEnabled")}{" "}
                <Link
                  href="/bank"
                  className="font-medium underline underline-offset-2"
                >
                  {t("pay.openBank")}
                </Link>
              </AlertDescription>
            </Alert>
          ))}
        {status === "payment-pending" && (
          <SignPayment
            payoutId={payoutId}
            stage="payment-pending"
            signingUrl={signingUrl}
            signingQr={signingQr}
          />
        )}
        {status === "complete" && (
          <p className="inline-flex items-center gap-2 text-sm text-muted-foreground">
            <Check className="size-4 text-success" />
            {t("complete.hint")}
          </p>
        )}
      </div>

      {/* Outstanding fee sweep — the burn succeeded but CP's transfer of the
          retained cut didn't run. Shown at any stage until it's swept. */}
      {feeTransferPending && (
        <div className="space-y-2 border-t border-border pt-3">
          <Alert variant="warning">
            <AlertTriangle className="size-4" />
            <AlertDescription>{tFee("pending")}</AlertDescription>
          </Alert>
          <FeeTransferButton payoutId={payoutId} />
        </div>
      )}

      {/* Escape hatch: settled out-of-band → close the payout without the
          burn + SEPA flow. Hidden once already complete. */}
      {status !== "complete" && (
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 border-t border-border pt-3">
          <span className="text-xs text-muted-foreground">
            {t("markComplete.hint")}
          </span>
          <MarkCompleteDialog payoutId={payoutId} />
        </div>
      )}
    </section>
  );
}

// Retry the standalone fee sweep for a burned payout whose cut wasn't swept.
// The action is idempotent on CP's side and calls refresh() on success, so a
// successful sweep makes the surrounding affordance disappear on re-render.
function FeeTransferButton({ payoutId }: { payoutId: string }) {
  const t = useTranslations("fund.payments.settlement.feeTransfer");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const onClick = () => {
    setError(null);
    startTransition(async () => {
      const res = await feeTransferAction({ payoutId });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setDone(res.feeTransferTxHash);
    });
  };

  if (done) {
    return (
      <Alert>
        <Check className="size-4" />
        <AlertDescription>
          <div>{t("done")}</div>
          <div className="mt-1 font-mono text-xs break-all">{done}</div>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="space-y-2">
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={onClick}
        disabled={pending}
      >
        {pending ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Coins className="size-4" />
        )}
        {t("button")}
      </Button>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </div>
  );
}

// Admin override — mark the payout complete without burning tokens or paying.
// Confirmed first because it bypasses settlement and can't be undone.
function MarkCompleteDialog({ payoutId }: { payoutId: string }) {
  const t = useTranslations("fund.payments.settlement.process.markComplete");
  const tRoot = useTranslations();
  const router = useRouter();
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
      const result = await completePayoutAction({ payoutId });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      // The action revalidated the detail path; refresh the client router so
      // the stepper + status badge re-render as complete right away.
      // (`refresh` from next/cache is server-action-only — use the router.)
      router.refresh();
      onOpenChange(false);
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <Check className="size-4" />
            {t("button")}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertDescription>{t("warning")}</AlertDescription>
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
            disabled={pending}
          >
            {tRoot("common.cancel")}
          </Button>
          <Button type="button" onClick={onConfirm} disabled={pending}>
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Check className="size-4" />
            )}
            {t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Stepper({ status }: { status: PayoutStatus }) {
  const t = useTranslations("fund.payments.settlement.process.steps");
  const current = STEPS.findIndex((s) => s.status === status);

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      {STEPS.map((step, i) => (
        <Fragment key={step.status}>
          {i > 0 && (
            <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/40" />
          )}
          <span
            className={cn(
              "inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-medium",
              i === current
                ? "bg-primary/10 text-primary ring-1 ring-primary/20"
                : i < current
                  ? "text-muted-foreground"
                  : "text-muted-foreground/50",
            )}
          >
            {i < current && <Check className="size-3" />}
            {t(step.key)}
          </span>
        </Fragment>
      ))}
    </div>
  );
}

function ActionRow({
  hint,
  children,
}: {
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {children}
      <span className="text-sm text-muted-foreground">{hint}</span>
    </div>
  );
}

function RefreshStatus({ payoutId }: { payoutId: string }) {
  const t = useTranslations("fund.payments.settlement.process");
  const [pending, startTransition] = useTransition();
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      title={t("refresh")}
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await getPayoutStatusAction({ payoutId });
        })
      }
    >
      {pending ? (
        <Loader2 className="size-4 animate-spin" />
      ) : (
        <RefreshCw className="size-4" />
      )}
    </Button>
  );
}

// Present the signing step. The signing URL + QR come from /status (passed
// down as props) and survive reloads. At the burnt stage there's no payment
// yet, so we show "Pay merchant" to create it — once created, the status
// flips to payment-pending and the QR + browser button render from props.
function SignPayment({
  payoutId,
  stage,
  signingUrl,
  signingQr,
}: {
  payoutId: string;
  stage: "burnt" | "payment-pending";
  signingUrl: string | null;
  signingQr: string | null;
}) {
  const t = useTranslations("fund.payments.settlement.process");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const create = () => {
    setError(null);
    startTransition(async () => {
      const result = await createPayoutPaymentAction({ payoutId });
      // On success the action revalidates → page re-renders at
      // payment-pending with the signing URL from /status.
      if ("error" in result) setError(result.error);
    });
  };

  // While the signing QR is up, poll for completion (the operator signs on a
  // phone or another tab). Pause when the tab is hidden; resume + check
  // immediately on refocus. Refresh the route only when the status actually
  // moves off payment-pending, so we don't churn the page on every tick.
  const showingQr = Boolean(signingUrl && signingQr);
  useEffect(() => {
    if (!showingQr) return;
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | null = null;

    const tick = async () => {
      if (document.hidden) return;
      const { status } = await pollPayoutStatusAction({ payoutId });
      if (cancelled) return;
      if (status && status !== "payment-pending") router.refresh();
    };
    const start = () => {
      if (!timer) timer = setInterval(tick, POLL_INTERVAL_MS);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVisibility = () => {
      if (document.hidden) {
        stop();
      } else {
        void tick(); // catch up immediately when they come back
        start();
      }
    };

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      cancelled = true;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [showingQr, payoutId, router]);

  // Signing options available (payment-pending with a live signing URL).
  if (signingUrl && signingQr) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">{t("sign.hint")}</p>
        <div className="flex flex-wrap items-center gap-5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={signingQr}
            alt=""
            width={160}
            height={160}
            className="rounded-lg border border-border bg-white p-1"
          />
          <div className="space-y-2">
            <a
              href={signingUrl}
              target="_blank"
              rel="noopener noreferrer"
              className={buttonVariants({ variant: "default", size: "sm" })}
            >
              <ExternalLink className="size-4" />
              {t("sign.browser")}
            </a>
            <p className="max-w-xs text-xs text-muted-foreground">
              {t("sign.qrHint")}
            </p>
          </div>
        </div>
        <div className="border-t border-border pt-3">
          <ActionRow hint={t("awaiting.hint")}>
            <CheckStatusButton payoutId={payoutId} />
          </ActionRow>
        </div>
      </div>
    );
  }

  // Payment-pending but no signing URL resolved — let the operator poll.
  if (stage === "payment-pending") {
    return (
      <ActionRow hint={t("awaiting.hint")}>
        <CheckStatusButton payoutId={payoutId} />
      </ActionRow>
    );
  }

  // Burnt: create the bank payment.
  return (
    <div className="space-y-2">
      <ActionRow hint={t("pay.hint")}>
        <Button variant="default" size="sm" onClick={create} disabled={pending}>
          {pending && <Loader2 className="size-4 animate-spin" />}
          {t("sign.create")}
        </Button>
      </ActionRow>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function BurnDialog({ payoutId }: { payoutId: string }) {
  const t = useTranslations("fund.payments.settlement.burn");
  const tRoot = useTranslations();
  const format = useFormatter();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [fee, setFee] = useState<{
    txHash: string | null;
    amount: string | null;
    pending: boolean;
    error: string | null;
  } | null>(null);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      // A failed burn may have left CP's claim in flight (another attempt is
      // running, or ours may have reached the chain) — re-render so the page
      // shows the claim panel instead of offering Burn again.
      if (error) router.refresh();
      setError(null);
      setTxHash(null);
      setWarning(null);
      setFee(null);
    }
  }

  const onConfirm = () => {
    setError(null);
    startTransition(async () => {
      const result = await burnPayoutAction({ payoutId });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setTxHash(result.txHash);
      setWarning(result.warning ?? null);
      setFee({
        txHash: result.feeTransferTxHash ?? null,
        amount: result.feeAmount ?? null,
        pending: result.feeTransferPending ?? false,
        error: result.feeTransferError ?? null,
      });
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button variant="default" size="sm">
            <Flame className="size-4" />
            {t("button")}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        {txHash ? (
          <div className="space-y-4">
            <Alert>
              <AlertDescription>
                <div>{t("success")}</div>
                <div className="mt-1 font-mono text-xs break-all">{txHash}</div>
                {fee?.txHash && (
                  <div className="mt-2 border-t border-border pt-2">
                    <div>
                      {t("feeSwept", {
                        amount: fee.amount
                          ? format.number(Number(fee.amount), {
                              style: "currency",
                              currency: "EUR",
                            })
                          : "",
                      })}
                    </div>
                    <div className="mt-1 font-mono text-xs break-all">
                      {fee.txHash}
                    </div>
                  </div>
                )}
              </AlertDescription>
            </Alert>
            {warning && (
              <Alert variant="warning">
                <AlertTriangle className="size-4" />
                <AlertDescription>{warning}</AlertDescription>
              </Alert>
            )}
            {fee?.pending && (
              <>
                <Alert variant="warning">
                  <AlertTriangle className="size-4" />
                  <AlertDescription>
                    <div>{t("feeNotSwept")}</div>
                    {fee.error && (
                      <div className="mt-1 text-xs opacity-90">{fee.error}</div>
                    )}
                  </AlertDescription>
                </Alert>
                <FeeTransferButton payoutId={payoutId} />
              </>
            )}
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
              <AlertDescription>{t("warning")}</AlertDescription>
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
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

// A burn was started (CP's claim is taken) but nothing is recorded. The admin
// checks the chain — helped by what we know of the attempt — and either
// records the burn's hash or, once the claim is old enough that no live burn
// can still be on its way, releases it. Both sit behind a confirmation dialog.
function BurnClaimPanel({
  payoutId,
  claim,
}: {
  payoutId: string;
  claim: BurnClaimView;
}) {
  const t = useTranslations("fund.payments.settlement.burnClaim");
  const attempt = claim.attempt;
  const confirmedHash =
    attempt?.kind === "sent" && attempt.status === "success" ? attempt.txHash : null;
  return (
    <div className="space-y-3">
      <Alert variant="warning">
        <AlertTriangle className="size-4" />
        <AlertDescription>
          <div className="font-medium">
            {t("started", { time: claim.startedAt })}
          </div>
          <div className="mt-1">{t("hint")}</div>
        </AlertDescription>
      </Alert>
      {attempt && attempt.kind !== "none" && <BurnAttemptInfo attempt={attempt} />}
      <div className="flex flex-wrap items-center gap-2">
        <RecordBurnDialog payoutId={payoutId} prefill={confirmedHash} />
        {/* Keyed by claim: a new claim restarts its own 10-minute wait. */}
        <ReleaseBurnClaimDialog
          key={claim.claimId ?? claim.startedAt}
          payoutId={payoutId}
          claim={claim}
        />
      </div>
    </div>
  );
}

// The attempt behind the claim, as far as we can see it: its userop / tx hash
// and what the bundler says about it now.
function BurnAttemptInfo({
  attempt,
}: {
  attempt: Exclude<BurnAttempt, { kind: "none" }>;
}) {
  const t = useTranslations("fund.payments.settlement.burnClaim.attempt");
  let advice: string;
  if (attempt.kind === "running") advice = t("running");
  else if (attempt.kind === "notSent") advice = t("notSent");
  else if (attempt.status === "success") advice = t("success");
  else if (attempt.status === "reverted") advice = t("reverted");
  else if (attempt.status === "pending" || attempt.status === "submitted") {
    advice = t("pending");
  } else advice = t("unknown");

  return (
    <div className="space-y-1 rounded-lg border border-border px-3 py-2 text-sm">
      <div>{advice}</div>
      {attempt.kind === "sent" && attempt.userOpHash && (
        <div className="text-xs text-muted-foreground">
          {t("userOp")}{" "}
          <span className="font-mono break-all">{attempt.userOpHash}</span>
        </div>
      )}
      {attempt.kind === "sent" && attempt.txHash && (
        <div className="text-xs text-muted-foreground">
          {t("tx")} <span className="font-mono break-all">{attempt.txHash}</span>
        </div>
      )}
    </div>
  );
}

function RecordBurnDialog({
  payoutId,
  prefill,
}: {
  payoutId: string;
  // A confirmed hash for the attempt, when we found one.
  prefill: string | null;
}) {
  const t = useTranslations("fund.payments.settlement.burnClaim.record");
  const tRoot = useTranslations();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [hash, setHash] = useState(prefill ?? "");
  const valid = TX_HASH.test(hash.trim());

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setHash(prefill ?? "");
    } else {
      // After an error the payout may still have moved (a duplicate burn was
      // recorded, the claim went away) — re-read it.
      if (error) router.refresh();
      setError(null);
    }
  }

  const onConfirm = () => {
    setError(null);
    startTransition(async () => {
      const result = await recordPayoutBurnAction({
        payoutId,
        txHash: hash.trim(),
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      // The action refreshed the route: the payout re-renders as burnt.
      onOpenChange(false);
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button variant="default" size="sm">
            <Flame className="size-4" />
            {t("button")}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor={`burn-hash-${payoutId}`}>{t("label")}</Label>
          <Input
            id={`burn-hash-${payoutId}`}
            value={hash}
            onChange={(e) => setHash(e.target.value)}
            placeholder="0x…"
            className="font-mono"
            autoComplete="off"
            spellCheck={false}
            disabled={pending}
          />
          {hash.trim() !== "" && !valid && (
            <p className="text-xs text-destructive">
              {tRoot("fund.payments.settlement.errors.txHashInvalid")}
            </p>
          )}
          <p className="text-xs text-muted-foreground">{t("verifyHint")}</p>
        </div>
        {error && (
          <Alert variant="destructive">
            <AlertTriangle className="size-4" />
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
            onClick={onConfirm}
            disabled={pending || !valid}
          >
            {pending && <Loader2 className="size-4 animate-spin" />}
            {t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// True once `atMs` has passed; re-renders when it does. Starts false so the
// server render and hydration agree (no clock reads during render). A new
// `atMs` belongs to a new claim — the caller remounts (key) to reset it.
function useHasPassed(atMs: number): boolean {
  const [passed, setPassed] = useState(false);
  useEffect(() => {
    const timer = setTimeout(
      () => setPassed(true),
      Math.max(0, atMs - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [atMs]);
  return passed;
}

function ReleaseBurnClaimDialog({
  payoutId,
  claim,
}: {
  payoutId: string;
  claim: BurnClaimView;
}) {
  const t = useTranslations("fund.payments.settlement.burnClaim.release");
  const tRoot = useTranslations();
  const router = useRouter();
  const releasable = useHasPassed(claim.releasableAtMs);
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
      const result = await releasePayoutBurnClaimAction({
        payoutId,
        claimId: claim.claimId,
      });
      if ("error" in result) {
        setError(result.error);
        // The claim is no longer the one shown: re-read the page so the
        // admin sees the current one (or none).
        if (result.stale) router.refresh();
        return;
      }
      // The action refreshed the route: the Burn button is back.
      onOpenChange(false);
    });
  };

  return (
    <div className="flex flex-col gap-1">
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogTrigger
          disabled={!releasable}
          render={
            <Button variant="outline" size="sm" disabled={!releasable}>
              <Unlock className="size-4" />
              {t("button")}
            </Button>
          }
        />
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("title")}</DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>
          </DialogHeader>
          <Alert variant="destructive">
            <AlertTriangle className="size-4" />
            <AlertDescription>{t("warning")}</AlertDescription>
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
      {!releasable && claim.releasableAtLabel && (
        <span className="max-w-xs text-xs text-muted-foreground">
          {t("availableAt", { time: claim.releasableAtLabel })}
        </span>
      )}
    </div>
  );
}

function CheckStatusButton({ payoutId }: { payoutId: string }) {
  const t = useTranslations("fund.payments.settlement.statusCheck");
  const tStatuses = useTranslations("fund.payments.settlement.statuses");
  const [pending, startTransition] = useTransition();
  const [label, setLabel] = useState<string | null>(null);

  const onClick = () => {
    startTransition(async () => {
      const result = await getPayoutStatusAction({ payoutId });
      if ("error" in result) setLabel(result.error);
      else setLabel(tStatuses(result.status));
    });
  };

  return (
    <div className="flex flex-col gap-1">
      <Button variant="default" size="sm" onClick={onClick} disabled={pending}>
        {pending ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <RefreshCw className="size-4" />
        )}
        {t("button")}
      </Button>
      {label && <span className="text-xs text-muted-foreground">{label}</span>}
    </div>
  );
}
