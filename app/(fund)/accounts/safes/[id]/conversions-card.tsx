// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { AlertTriangle, Check, Circle, ExternalLink, Loader2, Play, Repeat, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cancelConversionAction, continueConversionAction } from "@/services/convert/admin-actions";
import { cowExplorerOrderUrl, type ConversionView } from "@/services/convert/views";
import type { FundConversionStatus } from "@/services/db/generated/enums";
import type { SigningPasskeyHandle } from "@/services/safe/action-types";
import { explorerTxUrl } from "@/services/safe/config";

import { shortAddress } from "../format";
import { useStepUp } from "@/components/reauth-dialog";
import { useProposeAndSign, type ProposalOutcome } from "../passkey-hooks";
import { ProposalResult } from "./proposal-result";

// The Safe's conversions (services/convert): where each one stands, its
// CoW order, and — when the engine waits for an owner — the button that
// proposes the next step, or cancels. A conversion whose proposal is still
// collecting signatures shows up in the pending list too.

const STATUS_VARIANT: Record<FundConversionStatus, "info" | "warning" | "success" | "outline" | "destructive"> = {
  PROPOSED: "info",
  READY: "warning",
  FILLING: "info",
  DONE: "success",
  EXPIRED: "outline",
  CANCELLED: "outline",
  FAILED: "destructive",
};

export function ConversionsCard({
  safeId,
  chainId,
  threshold,
  conversions,
  canAct,
  hasPasskey,
  me,
}: {
  safeId: string;
  chainId: number;
  threshold: number;
  conversions: ConversionView[];
  canAct: boolean;
  hasPasskey: boolean;
  me: SigningPasskeyHandle | null;
}) {
  const t = useTranslations("fund.safes.conversion");
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });

  return (
    <section className="space-y-3">
      <h2 className="font-heading text-lg font-medium">
        {t("card.title")}
        <span className="ml-2 text-sm text-muted-foreground tabular-nums">{conversions.length}</span>
      </h2>
      <div className="space-y-3">
        {conversions.map((c) => (
          <ConversionRow
            key={c.id}
            safeId={safeId}
            chainId={chainId}
            threshold={threshold}
            conversion={c}
            canAct={canAct}
            hasPasskey={hasPasskey}
            me={me}
            relative={(iso) => format.relativeTime(new Date(iso), now)}
            expired={Boolean(c.validUntil && new Date(c.validUntil).getTime() < now.getTime())}
          />
        ))}
      </div>
    </section>
  );
}

function ConversionRow({
  safeId,
  chainId,
  threshold,
  conversion: c,
  canAct,
  hasPasskey,
  me,
  relative,
  expired,
}: {
  safeId: string;
  chainId: number;
  threshold: number;
  conversion: ConversionView;
  canAct: boolean;
  hasPasskey: boolean;
  me: SigningPasskeyHandle | null;
  relative: (iso: string) => string;
  expired: boolean;
}) {
  const t = useTranslations("fund.safes.conversion");
  const tRoot = useTranslations();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [cancelling, startCancel] = useTransition();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ProposalOutcome | null>(null);
  const stepUp = useStepUp(hasPasskey);
  const { finish } = useProposeAndSign(safeId, me);

  const orderHref = c.orderUid ? cowExplorerOrderUrl(chainId, c.orderUid) : null;
  const line =
    c.status === "DONE" && c.to.amount
      ? t("card.lineDone", { from: `${c.from.amount} ${c.from.symbol}`, to: `${c.to.amount} ${c.to.symbol}` })
      : t("card.line", { from: `${c.from.amount} ${c.from.symbol}`, to: `${c.to.min} ${c.to.symbol}` });

  const onContinue = () => {
    setError(null);
    startTransition(async () => {
      const res = await continueConversionAction({ safeId, conversionId: c.id });
      if (stepUp.check(res, onContinue)) return;
      router.refresh();
      if ("error" in res) {
        setError(res.error);
        return;
      }
      const outcome = await finish(res);
      router.refresh();
      setResult(outcome);
    });
  };

  const onCancel = () => {
    setError(null);
    startCancel(async () => {
      const res = await cancelConversionAction({ safeId, conversionId: c.id });
      setConfirmCancel(false);
      if ("error" in res) setError(res.error);
      router.refresh();
    });
  };

  const ready = c.status === "READY" && canAct;

  return (
    <Card size="sm">
      <CardContent className="space-y-3">
        <div className="flex items-start gap-3">
          <span
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
            aria-hidden
          >
            <Repeat className="size-4" />
          </span>
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium tabular-nums break-words">{line}</span>
              <Badge variant={STATUS_VARIANT[c.status]}>{t(`status.${c.status}`)}</Badge>
              {c.status === "PROPOSED" && expired && (
                <Badge variant="destructive">
                  <AlertTriangle />
                  {t("status.EXPIRED")}
                </Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {c.createdBy ? t("card.by", { name: c.createdBy.name ?? "?" }) : null}
              {c.createdBy ? " · " : null}
              <time dateTime={c.createdAt} suppressHydrationWarning>
                {relative(c.createdAt)}
              </time>
              {orderHref && (
                <>
                  {" · "}
                  <a
                    href={orderHref}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-0.5 underline underline-offset-3 hover:text-foreground"
                  >
                    {t("card.order")}
                    <ExternalLink className="size-3" />
                  </a>
                </>
              )}
            </p>
            {c.progress.length > 0 && (
              <ol className="mt-1.5 space-y-1 text-xs">
                {c.progress.map((s) => (
                  <li key={s.key} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                    {s.state === "done" ? (
                      <Check className="size-3.5 shrink-0 text-success" aria-hidden />
                    ) : s.state === "active" ? (
                      <Loader2 className="size-3.5 shrink-0 animate-spin text-info" aria-hidden />
                    ) : (
                      <Circle className="size-3.5 shrink-0 text-muted-foreground/40" aria-hidden />
                    )}
                    <span className={s.state === "pending" ? "text-muted-foreground" : undefined}>
                      {t(`progress.${s.key}` as never)}
                    </span>
                    {s.txHash && (
                      <a
                        href={explorerTxUrl(chainId, s.txHash)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="font-mono text-muted-foreground hover:text-foreground"
                      >
                        {shortAddress(s.txHash)}
                      </a>
                    )}
                  </li>
                ))}
              </ol>
            )}
            {c.status === "FILLING" && <p className="text-xs text-muted-foreground">{t("card.fillHint")}</p>}
            {c.status === "READY" && c.round > 0 && c.to.amount === null && (
              <p className="text-xs text-muted-foreground">{t("card.readyHint")}</p>
            )}
            {c.status === "PROPOSED" && expired && (
              <p className="text-xs text-destructive">{t("card.proposalExpired")}</p>
            )}
            {c.status === "FAILED" && c.errorMessage && (
              <p className="text-xs text-destructive break-words">{c.errorMessage}</p>
            )}
          </div>
        </div>

        {result && (
          <ProposalResult
            chainId={chainId}
            executed={result.executed}
            txHash={result.txHash}
            threshold={threshold}
            unsigned={result.unsigned}
            error={result.error}
          />
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {ready && !result && (
          <div className="flex flex-wrap items-center justify-end gap-2">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setConfirmCancel(true)}
              disabled={pending || cancelling}
            >
              <X className="size-4" />
              {t("card.cancel")}
            </Button>
            <Button type="button" size="sm" onClick={onContinue} disabled={pending || cancelling}>
              {pending ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
              {t("card.continue")}
            </Button>
          </div>
        )}

        <Dialog open={confirmCancel} onOpenChange={(o) => !cancelling && setConfirmCancel(o)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("card.cancelTitle")}</DialogTitle>
              <DialogDescription>{t("card.cancelDescription")}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setConfirmCancel(false)} disabled={cancelling}>
                {tRoot("common.cancel")}
              </Button>
              <Button type="button" variant="destructive" onClick={onCancel} disabled={cancelling}>
                {cancelling ? <Loader2 className="size-4 animate-spin" /> : <X className="size-4" />}
                {t("card.cancelConfirm")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        {stepUp.dialog}
      </CardContent>
    </Card>
  );
}
