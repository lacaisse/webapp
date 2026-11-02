// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { AlertTriangle, CheckCircle2, Fingerprint, Loader2, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition, type ReactNode } from "react";

import { useStepUp } from "@/components/reauth-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
  deploySigningPasskeyAction,
  finishSigningPasskeyRegistrationAction,
  startSigningPasskeyRegistrationAction,
} from "@/services/safe/passkey-actions";
import {
  ceremonyErrorMessage,
  createSigningPasskey,
  isCeremonyCancelled,
} from "@/services/safe/passkey-client";

import { SafeAddress } from "./safe-address";

export type RegisteredPasskey = {
  address: string;
  deployed: boolean;
  backupEligible: boolean;
  backupState: boolean;
  deployError: string | null;
};

// The registration ceremony for a member's Safe signing passkey of this
// fund (services/safe/passkey-actions.ts). `replace` registers a successor
// for a lost device. Step-up gated: the start action asks for a fresh
// re-authentication first.
export function SigningPasskeyDialog({
  open,
  onOpenChange,
  replace,
  hasPasskey,
  onRegistered,
  trigger,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  replace: boolean;
  hasPasskey: boolean; // login passkey → the re-auth dialog offers it
  onRegistered?: (passkey: RegisteredPasskey) => void;
  trigger?: ReactNode;
}) {
  const t = useTranslations("fund.safes.passkey");
  const tRoot = useTranslations();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [deploying, startDeploy] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<RegisteredPasskey | null>(null);
  const stepUp = useStepUp(hasPasskey);

  function reset() {
    setError(null);
    setResult(null);
  }

  const onRegister = () => {
    setError(null);
    startTransition(async () => {
      const start = await startSigningPasskeyRegistrationAction({ replace });
      if (stepUp.check(start, onRegister)) return;
      if ("error" in start) {
        setError(start.error);
        return;
      }
      let response;
      try {
        response = await createSigningPasskey(start.options);
      } catch (e) {
        if (!isCeremonyCancelled(e)) setError(ceremonyErrorMessage(e, t("ceremonyFailed")));
        return;
      }
      const finish = await finishSigningPasskeyRegistrationAction({
        challengeId: start.challengeId,
        response,
      });
      if ("error" in finish) {
        setError(finish.error);
        return;
      }
      const registered: RegisteredPasskey = {
        address: finish.address,
        deployed: finish.deployed,
        backupEligible: finish.backupEligible,
        backupState: finish.backupState,
        deployError: finish.deployError,
      };
      setResult(registered);
      onRegistered?.(registered);
      router.refresh();
    });
  };

  const onRetryDeploy = () => {
    setError(null);
    startDeploy(async () => {
      const res = await deploySigningPasskeyAction();
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setResult((r) => (r ? { ...r, deployed: true, deployError: null } : r));
      router.refresh();
    });
  };

  const busy = pending || deploying || stepUp.pending;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        onOpenChange(next);
        if (!next) reset();
      }}
    >
      {trigger && <DialogTrigger render={<>{trigger}</>} />}
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Fingerprint className="size-4" />
            {replace ? t("replaceTitle") : t("registerTitle")}
          </DialogTitle>
          <DialogDescription>
            {replace ? t("replaceDescription") : t("registerDescription")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {result ? (
            <>
              <Alert>
                <CheckCircle2 className="size-4" />
                <AlertTitle>{t("registeredTitle")}</AlertTitle>
                <AlertDescription className="space-y-1">
                  <p>{t("registeredBody")}</p>
                  <SafeAddress address={result.address} />
                </AlertDescription>
              </Alert>
              {result.backupState ? (
                <p className="text-xs text-muted-foreground">{t("backedUpHint")}</p>
              ) : (
                <Alert variant="warning">
                  <AlertTriangle className="size-4" />
                  <AlertDescription>{t("deviceOnlyHint")}</AlertDescription>
                </Alert>
              )}
              {!result.deployed && (
                <Alert variant="destructive">
                  <AlertTriangle className="size-4" />
                  <AlertTitle>{t("deployFailedTitle")}</AlertTitle>
                  <AlertDescription className="space-y-2">
                    {result.deployError && <p className="break-words font-mono text-xs">{result.deployError}</p>}
                    <Button type="button" size="sm" variant="outline" onClick={onRetryDeploy} disabled={busy}>
                      {deploying ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                      {t("retryDeploy")}
                    </Button>
                  </AlertDescription>
                </Alert>
              )}
            </>
          ) : (
            <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
              <li>{t("explainOwnKey")}</li>
              <li>{t("explainPerFund")}</li>
              <li>{t("explainBackup")}</li>
              {replace && <li>{t("explainReplace")}</li>}
            </ul>
          )}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>

        <DialogFooter>
          {result ? (
            <Button type="button" onClick={() => onOpenChange(false)} disabled={busy}>
              {tRoot("common.close")}
            </Button>
          ) : (
            <>
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
                {tRoot("common.cancel")}
              </Button>
              <Button type="button" onClick={onRegister} disabled={busy}>
                {pending ? <Loader2 className="size-4 animate-spin" /> : <Fingerprint className="size-4" />}
                {pending ? t("waiting") : replace ? t("replaceConfirm") : t("registerConfirm")}
              </Button>
            </>
          )}
        </DialogFooter>
        {stepUp.dialog}
      </DialogContent>
    </Dialog>
  );
}

/** A button that opens the registration dialog. */
export function RegisterSigningPasskeyButton({
  replace,
  hasPasskey,
  onRegistered,
  size = "sm",
  variant = "default",
  label,
}: {
  replace: boolean;
  hasPasskey: boolean;
  onRegistered?: (passkey: RegisteredPasskey) => void;
  size?: "xs" | "sm" | "default";
  variant?: "default" | "outline" | "ghost";
  label?: string;
}) {
  const t = useTranslations("fund.safes.passkey");
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" size={size} variant={variant} onClick={() => setOpen(true)}>
        <Fingerprint className="size-4" />
        {label ?? (replace ? t("replaceTrigger") : t("registerTrigger"))}
      </Button>
      <SigningPasskeyDialog
        open={open}
        onOpenChange={setOpen}
        replace={replace}
        hasPasskey={hasPasskey}
        onRegistered={onRegistered}
      />
    </>
  );
}
