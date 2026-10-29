// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import {
  Ban,
  Check,
  Circle,
  Loader2,
  PenLine,
  RotateCcw,
  Wallet,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useFormatter, useNow, useTranslations } from "next-intl";
import { useState, useTransition, type ReactNode } from "react";

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
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  proposeRejectionAction,
  retryExecutionAction,
  signTransactionAction,
} from "@/services/safe/admin-actions";

import type { SafeTxView } from "../data";
import { sameAddress, summaryLine } from "../format";
import { useStepUp } from "../reauth-dialog";
import type { OwnerRow } from "./owners-card";
import { TxDetails } from "./tx-details";
import { TxKindIcon } from "./tx-kind-icon";

// One open Safe transaction: what it does, who proposed it, and — the point
// of the whole page — one chip per current owner saying whether they signed,
// when and where.
export function PendingTxCard({
  safeId,
  chainId,
  tx,
  owners,
  threshold,
  currentSignerAddress,
  tokenSymbol,
  names,
  safeWalletTxHref,
  canAct,
  rejectionProposed,
  nextNonce,
  hasPasskey,
}: {
  nextNonce: number | null; // lowest open nonce — the one the Safe runs next
  hasPasskey: boolean;
  safeId: string;
  chainId: number;
  tx: SafeTxView;
  owners: OwnerRow[];
  threshold: number;
  currentSignerAddress: string | null;
  tokenSymbol: string | null;
  names: Record<string, string>;
  safeWalletTxHref: string | null;
  canAct: boolean;
  rejectionProposed: boolean;
}) {
  const t = useTranslations("fund.safes");
  const format = useFormatter();
  const now = useNow({ updateInterval: 60_000 });
  const router = useRouter();
  const [retrying, startRetry] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const stepUp = useStepUp(hasPasskey);

  const signatureFor = (address: string) =>
    tx.signatures.find((s) => sameAddress(s.ownerAddress, address));
  const signedOwners = owners.filter((o) => signatureFor(o.address));
  const missing = owners.filter((o) => !signatureFor(o.address));
  const signedCount = signedOwners.length;

  const me = currentSignerAddress
    ? owners.find((o) => sameAddress(o.address, currentSignerAddress))
    : undefined;
  const canSign =
    canAct && tx.status === "PENDING" && Boolean(me) && !signatureFor(me!.address);
  const canReject =
    canAct &&
    tx.kind !== "REJECTION" &&
    !rejectionProposed &&
    (tx.status === "PENDING" || tx.status === "FAILED");
  const waitingExternalOnly =
    tx.status === "PENDING" &&
    signedCount < threshold &&
    missing.length > 0 &&
    missing.every((o) => o.kind === "EXTERNAL");

  const line = summaryLine(tx.summary, t, tokenSymbol, { names, kind: tx.kind });
  const details = (
    <TxDetails
      summary={tx.summary}
      chainId={chainId}
      tokenSymbol={tokenSymbol}
      names={names}
      safeWalletTxHref={safeWalletTxHref}
      t={t}
    />
  );
  const relative = (iso: string) => format.relativeTime(new Date(iso), now);
  const absolute = (iso: string) =>
    format.dateTime(new Date(iso), { dateStyle: "medium", timeStyle: "short" });

  const onRetry = () => {
    setError(null);
    startRetry(async () => {
      const res = await retryExecutionAction({ safeId, transactionId: tx.id });
      if (stepUp.check(res, onRetry)) return;
      if ("error" in res) setError(res.error);
      router.refresh();
    });
  };

  return (
    <Card size="sm">
      <CardContent className="space-y-3">
        <div className="flex items-start gap-3">
          <TxKindIcon kind={tx.kind} />
          <div className="min-w-0 flex-1 space-y-0.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium break-words">{line}</span>
              <span className="font-mono text-xs text-muted-foreground">
                {t("tx.nonce", { nonce: tx.nonce })}
              </span>
              {nextNonce != null && tx.nonce === nextNonce ? (
                <Badge variant="info">{t("tx.nextInLine")}</Badge>
              ) : nextNonce != null ? (
                <span className="text-xs text-muted-foreground">
                  {t("tx.waitsFor", { nonce: nextNonce })}
                </span>
              ) : null}
              {tx.status === "FAILED" && (
                <Badge variant="destructive">{t("tx.status.FAILED")}</Badge>
              )}
              {rejectionProposed && tx.kind !== "REJECTION" && (
                <Badge variant="warning">{t("tx.rejectionProposed")}</Badge>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              {tx.proposedBy
                ? t("tx.proposedBy", { name: tx.proposedBy.name })
                : t("tx.proposedExternally")}
              {" · "}
              <time
                dateTime={tx.createdAt}
                title={absolute(tx.createdAt)}
                suppressHydrationWarning
              >
                {relative(tx.createdAt)}
              </time>
            </p>
            {tx.note && (
              <p className="text-sm text-muted-foreground italic">“{tx.note}”</p>
            )}
          </div>
        </div>

        {details}

        <div className="space-y-2">
          <div className="text-xs font-medium text-muted-foreground">
            {t("tx.signatures", { count: signedCount, total: threshold })}
          </div>
          <ul className="flex flex-wrap gap-1.5">
            {owners.map((o) => {
              const sig = signatureFor(o.address);
              const isMe = Boolean(me && sameAddress(me.address, o.address));
              const name = isMe ? t("tx.youName", { name: o.displayName }) : o.displayName;
              if (!sig) {
                return (
                  <li
                    key={o.address}
                    className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs text-muted-foreground ring-1 ring-border"
                    title={t("tx.notSigned")}
                  >
                    <Circle className="size-3" />
                    {name}
                  </li>
                );
              }
              const SourceIcon = sig.source === "SAFE_WALLET" ? Wallet : PenLine;
              return (
                <li
                  key={o.address}
                  className="inline-flex items-center gap-1.5 rounded-full bg-success/10 px-2.5 py-1 text-xs text-success ring-1 ring-success/25"
                  title={t("tx.signedAt", { date: absolute(sig.signedAt) })}
                >
                  <Check className="size-3" />
                  <span className="font-medium">{name}</span>
                  <time
                    dateTime={sig.signedAt}
                    className="text-success/80"
                    suppressHydrationWarning
                  >
                    {relative(sig.signedAt)}
                  </time>
                  <span className="inline-flex items-center gap-0.5 text-success/80">
                    <SourceIcon className="size-3" />
                    {t(`tx.source.${sig.source}`)}
                  </span>
                </li>
              );
            })}
          </ul>
          {waitingExternalOnly && (
            <p className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
              {t("tx.waitingExternal", {
                names: format.list(
                  missing.map((o) => o.displayName),
                  { type: "disjunction" },
                ),
              })}
            </p>
          )}
        </div>

        {tx.status === "FAILED" && tx.errorMessage && (
          <Alert variant="destructive">
            <AlertDescription className="break-words">{tx.errorMessage}</AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-wrap items-center gap-2">
          {tx.status === "EXECUTING" && (
            <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t("tx.executing")}
            </span>
          )}
          {canSign && (
            <SignDialog
              safeId={safeId}
              tx={tx}
              threshold={threshold}
              line={line}
              details={details}
              onError={setError}
              hasPasskey={hasPasskey}
            />
          )}
          {canAct && tx.status === "FAILED" && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onRetry}
              disabled={retrying}
            >
              {retrying ? <Loader2 className="animate-spin" /> : <RotateCcw />}
              {t("tx.retry")}
            </Button>
          )}
          {canReject && (
            <RejectDialog
              safeId={safeId}
              tx={tx}
              threshold={threshold}
              line={line}
              hasPasskey={hasPasskey}
            />
          )}
          {!canSign && me && tx.status === "PENDING" && signatureFor(me.address) && (
            <span className="text-xs text-muted-foreground">
              {t("tx.youSigned")}
            </span>
          )}
        </div>
        {stepUp.dialog}
      </CardContent>
    </Card>
  );
}

// Signing is final (a signature can't be withdrawn, only outvoted by a
// rejection), so it goes through a confirmation that repeats exactly what is
// being signed: full addresses, amount, token contract, threshold change.
function SignDialog({
  safeId,
  tx,
  threshold,
  line,
  details,
  onError,
  hasPasskey,
}: {
  safeId: string;
  tx: SafeTxView;
  threshold: number;
  line: string;
  details: ReactNode;
  hasPasskey: boolean;
  // Errors are shown on the card, not in the dialog: after the refresh the
  // user may no longer be able to sign (signature stored, execution failed),
  // which unmounts the dialog and would take its error with it.
  onError: (message: string) => void;
}) {
  const t = useTranslations("fund.safes.tx");
  const tRoot = useTranslations();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const stepUp = useStepUp(hasPasskey);

  const onConfirm = () => {
    startTransition(async () => {
      const res = await signTransactionAction({ safeId, transactionId: tx.id });
      // Not fresh enough: confirm identity, then sign again.
      if (stepUp.check(res, onConfirm)) return;
      if ("error" in res) onError(res.error);
      // Refresh on errors too: the signature may be stored and the execution
      // marked FAILED with its reason.
      router.refresh();
      setOpen(false);
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(n) => {
        if (pending || stepUp.pending) return;
        setOpen(n);
      }}
    >
      <DialogTrigger
        render={
          <Button type="button" size="sm">
            <PenLine />
            {t("sign")}
          </Button>
        }
      />
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("signTitle", { nonce: tx.nonce })}</DialogTitle>
          <DialogDescription className="break-words">{line}</DialogDescription>
        </DialogHeader>
        {details}
        <p className="text-sm text-muted-foreground">
          {t("signDescription", { threshold })}
        </p>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            {tRoot("common.cancel")}
          </Button>
          <Button type="button" onClick={onConfirm} disabled={pending}>
            {pending ? <Loader2 className="size-4 animate-spin" /> : <PenLine className="size-4" />}
            {t("signConfirm")}
          </Button>
        </DialogFooter>
        {stepUp.dialog}
      </DialogContent>
    </Dialog>
  );
}

function RejectDialog({
  safeId,
  tx,
  threshold,
  line,
  hasPasskey,
}: {
  safeId: string;
  tx: SafeTxView;
  threshold: number;
  line: string;
  hasPasskey: boolean;
}) {
  const t = useTranslations("fund.safes.tx");
  const tRoot = useTranslations();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const stepUp = useStepUp(hasPasskey);

  const onConfirm = () => {
    setError(null);
    startTransition(async () => {
      const res = await proposeRejectionAction({ safeId, transactionId: tx.id });
      if (stepUp.check(res, onConfirm)) return;
      router.refresh();
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setOpen(false);
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(n) => {
        if (pending || stepUp.pending) return;
        setOpen(n);
        if (!n) setError(null);
      }}
    >
      <DialogTrigger
        render={
          <Button type="button" size="sm" variant="ghost">
            <Ban />
            {t("reject")}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("rejectTitle", { nonce: tx.nonce })}</DialogTitle>
          <DialogDescription>{line}</DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {t("rejectDescription", { nonce: tx.nonce, threshold })}
        </p>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setOpen(false)}
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
            {pending ? <Loader2 className="size-4 animate-spin" /> : <Ban className="size-4" />}
            {t("rejectConfirm")}
          </Button>
        </DialogFooter>
        {stepUp.dialog}
      </DialogContent>
    </Dialog>
  );
}
