// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { ArrowRight, Fingerprint, KeyRound, Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { useStepUp } from "@/components/reauth-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { proposeOwnerChangeAction } from "@/services/safe/admin-actions";
import type { SigningPasskeyHandle } from "@/services/safe/action-types";
import type { SafeMigrationRow } from "@/services/safe/migration";

import { shortAddress } from "../format";
import { useProposeAndSign } from "../passkey-hooks";
import { RegisterSigningPasskeyButton } from "../signing-passkey-dialog";
import { deploySigningPasskeyAction } from "@/services/safe/passkey-actions";

// "Move to passkeys": one row per owner of this Safe that is still a
// server-held key (or a replaced passkey), with the step it is at. Every
// step is the member's own doing (register, deploy) or an ordinary proposal
// the other owners sign (the swap). Nothing runs on its own.
export function MigrationBanner({
  safeId,
  rows,
  threshold,
  canPropose,
  hasPasskey,
  me,
}: {
  safeId: string;
  rows: SafeMigrationRow[];
  threshold: number;
  canPropose: boolean; // the viewer owns this Safe (can propose the swap)
  hasPasskey: boolean;
  me: SigningPasskeyHandle | null;
}) {
  const t = useTranslations("fund.safes.migration");
  const router = useRouter();
  const [busyOwner, setBusyOwner] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const stepUp = useStepUp(hasPasskey);
  const { finish } = useProposeAndSign(safeId, me);

  if (rows.length === 0) return null;
  const serverKeys = rows.filter((r) => r.reason === "server_key").length;

  const proposeSwap = (row: SafeMigrationRow) => {
    if (!row.userId) return;
    setError(null);
    setBusyOwner(row.ownerAddress);
    startTransition(async () => {
      const res = await proposeOwnerChangeAction({
        safeId,
        change: { kind: "SWAP_OWNER", oldOwner: row.ownerAddress, memberUserId: row.userId! },
      });
      if (stepUp.check(res, () => proposeSwap(row))) return;
      if ("error" in res) {
        setError(res.error);
        setBusyOwner(null);
        router.refresh();
        return;
      }
      const outcome = await finish(res);
      if (outcome.error) setError(outcome.error);
      setBusyOwner(null);
      router.refresh();
    });
  };

  const deploy = (row: SafeMigrationRow) => {
    setError(null);
    setBusyOwner(row.ownerAddress);
    startTransition(async () => {
      const res = await deploySigningPasskeyAction();
      if ("error" in res) setError(res.error);
      setBusyOwner(null);
      router.refresh();
    });
  };

  return (
    <Alert variant="warning">
      <KeyRound className="size-4" />
      <AlertTitle>{t("title")}</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>{serverKeys > 0 ? t("bodyServerKeys", { count: serverKeys }) : t("bodyReplaced")}</p>
        <ul className="divide-y divide-border/60 rounded-md bg-background/60 ring-1 ring-border/60">
          {rows.map((row) => {
            const busy = pending && busyOwner === row.ownerAddress;
            return (
              <li key={row.ownerAddress} className="flex flex-wrap items-center gap-2 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5 text-sm font-medium text-foreground">
                    {row.displayName}
                    {row.isCurrentUser && <Badge variant="outline">{t("you")}</Badge>}
                    <Badge variant={row.reason === "server_key" ? "warning" : "info"}>
                      {t(`reason.${row.reason}`)}
                    </Badge>
                  </div>
                  <div className="flex flex-wrap items-center gap-1 font-mono text-xs text-muted-foreground">
                    <span>{shortAddress(row.ownerAddress)}</span>
                    {row.targetAddress && (
                      <>
                        <ArrowRight className="size-3" />
                        <span>{shortAddress(row.targetAddress)}</span>
                      </>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {row.step === "signing" && row.swap
                      ? t("step.signing", { count: row.swap.signatures, threshold })
                      : t(`step.${row.step}`)}
                  </p>
                </div>
                <StepAction
                  row={row}
                  busy={busy}
                  disabled={pending || stepUp.pending}
                  canPropose={canPropose}
                  hasPasskey={hasPasskey}
                  onPropose={() => proposeSwap(row)}
                  onDeploy={() => deploy(row)}
                />
              </li>
            );
          })}
        </ul>
        {error && <p className="text-sm text-destructive">{error}</p>}
        {stepUp.dialog}
      </AlertDescription>
    </Alert>
  );
}

function StepAction({
  row,
  busy,
  disabled,
  canPropose,
  hasPasskey,
  onPropose,
  onDeploy,
}: {
  row: SafeMigrationRow;
  busy: boolean;
  disabled: boolean;
  canPropose: boolean;
  hasPasskey: boolean;
  onPropose: () => void;
  onDeploy: () => void;
}) {
  const t = useTranslations("fund.safes.migration");
  switch (row.step) {
    case "register":
      return row.isCurrentUser ? (
        <RegisterSigningPasskeyButton
          replace={row.reason === "replaced_passkey"}
          hasPasskey={hasPasskey}
          label={t("actions.register")}
        />
      ) : (
        <span className="text-xs text-muted-foreground">{t("actions.waitRegister")}</span>
      );
    case "deploy":
      return row.isCurrentUser ? (
        <Button type="button" size="sm" variant="outline" onClick={onDeploy} disabled={disabled}>
          {busy ? <Loader2 className="animate-spin" /> : <Fingerprint />}
          {t("actions.deploy")}
        </Button>
      ) : (
        <span className="text-xs text-muted-foreground">{t("actions.waitDeploy")}</span>
      );
    case "propose":
      return canPropose && row.userId ? (
        <Button type="button" size="sm" onClick={onPropose} disabled={disabled}>
          {busy ? <Loader2 className="animate-spin" /> : <ArrowRight />}
          {t("actions.propose")}
        </Button>
      ) : (
        <span className="text-xs text-muted-foreground">{t("actions.waitPropose")}</span>
      );
    case "signing":
    case "executing":
    case "failed":
      return (
        <a href="#pending" className="text-xs font-medium underline underline-offset-2">
          {t(`actions.${row.step}`)}
        </a>
      );
  }
}
