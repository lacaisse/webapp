// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { Fingerprint, Loader2, ShieldCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { useCallback, useState, useTransition, type FormEvent } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { signIn } from "@/services/auth/client";
import { reauthWithPasswordAction } from "@/services/auth/step-up-actions";
import { isReauthRequired } from "@/services/safe/action-types";

// Step-up re-authentication (review S4). The Safe actions answer
// `reauth_required` when the user has not re-authenticated in the last 10
// minutes; `useStepUp` keeps the submit the action refused, opens this
// dialog, and runs it again once the user confirmed — by password (a server
// action verifies it and records the proof for this session) or by passkey
// when they have one (the plugin's assertion endpoint; the after-hook in
// services/auth/better-auth.ts records the proof). Nothing on the client
// decides freshness: the retried action checks the proof again.
export function ReauthDialog({
  open,
  hasPasskey,
  onCancel,
  onVerified,
}: {
  open: boolean;
  hasPasskey: boolean;
  onCancel: () => void;
  onVerified: () => void;
}) {
  const t = useTranslations("fund.safes.reauth");
  const tCommon = useTranslations("common");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pwPending, startPw] = useTransition();
  const [pkPending, startPk] = useTransition();
  const pending = pwPending || pkPending;

  function close() {
    setPassword("");
    setError(null);
    onCancel();
  }

  const onPasswordSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (password === "") return;
    setError(null);
    startPw(async () => {
      const res = await reauthWithPasswordAction({ password });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setPassword("");
      onVerified();
    });
  };

  const onPasskey = () => {
    setError(null);
    startPk(async () => {
      // Same ceremony as the login page; the response sets this host's
      // session cookie afresh and the step-up proof alongside it.
      const res = await signIn.passkey();
      if (res?.error) {
        setError(res.error.message ?? t("passkeyFailed"));
        return;
      }
      setPassword("");
      onVerified();
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        if (!next) close();
      }}
    >
      <DialogContent>
        <form onSubmit={onPasswordSubmit} className="contents">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <ShieldCheck className="size-4" />
              {t("title")}
            </DialogTitle>
            <DialogDescription>{t("description")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="safe-reauth-password">{t("password")}</Label>
              <Input
                id="safe-reauth-password"
                type="password"
                autoComplete="current-password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={pending}
              />
            </div>

            {hasPasskey && (
              <>
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-popover px-2 text-muted-foreground">
                      {tCommon("or")}
                    </span>
                  </div>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                  onClick={onPasskey}
                  disabled={pending}
                >
                  {pkPending ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Fingerprint className="size-4" />
                  )}
                  {pkPending ? t("passkeyWaiting") : t("passkeyButton")}
                </Button>
              </>
            )}

            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={close} disabled={pending}>
              {tCommon("cancel")}
            </Button>
            <Button type="submit" disabled={pending || password === ""}>
              {pwPending ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
              {pwPending ? t("confirming") : t("confirm")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Step-up glue for a dialog or card that calls a Safe action. Wrap the
 * action's result check with `stepUp.check(res, retry)`: when the action
 * asked for re-authentication it opens the dialog and, once confirmed,
 * calls `retry` (the same submit again); it returns true so the caller
 * stops there. Render `stepUp.dialog` inside the component.
 */
export function useStepUp(hasPasskey: boolean) {
  const [retry, setRetry] = useState<(() => void) | null>(null);

  const check = useCallback(
    (res: { code?: string } | { ok: true }, again: () => void): boolean => {
      if (!isReauthRequired(res)) return false;
      setRetry(() => again);
      return true;
    },
    [],
  );

  const dialog = (
    <ReauthDialog
      open={retry !== null}
      hasPasskey={hasPasskey}
      onCancel={() => setRetry(null)}
      onVerified={() => {
        const again = retry;
        setRetry(null);
        again?.();
      }}
    />
  );

  return { check, dialog, pending: retry !== null };
}
