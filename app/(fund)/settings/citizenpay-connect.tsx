// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { CheckCircle2, ExternalLink, KeyRound } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useState } from "react";

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

// CitizenPay API-key handoff UI for the fund settings page. Sits below
// the treasury_id form (CitizenPayForm).
//
// Three states:
//   1. No treasury_id yet → nothing to show; the form above prompts entry.
//   2. Treasury set, no API key → "Issue API key via Citizen Pay" link
//      (non-destructive, no confirm).
//   3. Treasury + API key → status block + "Rotate API key" gated behind
//      a confirmation dialog (rotation invalidates the previous key on
//      CP's side immediately).
//
// Both buttons hit /api/citizenpay/connect — the route uses the existing
// `citizenPayApiKeyId` to decide whether to label the new key "initial"
// or "rotated" in CP's audit log.

const SUCCESS_CODE = "ok";
const KNOWN_USER_ERRORS = new Set([
  "not_configured",
  "not_connected",
  "missing_params",
  "no_fund_host",
  "state_not_found",
  "state_expired",
  "state_consumed",
  "host_mismatch",
  "pickup_failed",
  "error",
]);

export type CitizenPayConnectStatus = {
  treasuryId: string | null;
  apiKeyId: string | null;
  // Serialised to ISO string in the server component — Date objects can't
  // cross the server/client boundary without round-tripping through JSON.
  apiKeyUpdatedAt: string | null;
  flash: string | null;
};

export function CitizenPayConnect({ status }: { status: CitizenPayConnectStatus }) {
  const t = useTranslations("fund.settings.citizenpay");
  const format = useFormatter();
  const hasTreasury = Boolean(status.treasuryId);
  const hasKey = Boolean(status.apiKeyId);

  return (
    <div className="space-y-6">
      <ConnectFlash flash={status.flash} />

      {hasTreasury ? (
        <div className="rounded-lg border bg-muted/30 p-4 space-y-1.5">
          {hasKey ? (
            <>
              <div className="flex items-center gap-2 text-sm font-medium">
                <CheckCircle2 className="size-4 text-emerald-600" />
                <span>{t("connect.status.connected")}</span>
              </div>
              <dl className="text-xs text-muted-foreground space-y-0.5">
                <div className="flex gap-2">
                  <dt className="min-w-24">{t("connect.apiKeyIdLabel")}</dt>
                  <dd className="font-mono break-all">{status.apiKeyId}</dd>
                </div>
                {status.apiKeyUpdatedAt ? (
                  <div className="flex gap-2">
                    <dt className="min-w-24">
                      {t("connect.apiKeyUpdatedAtLabel")}
                    </dt>
                    <dd>
                      {format.dateTime(new Date(status.apiKeyUpdatedAt), {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}
                    </dd>
                  </div>
                ) : null}
              </dl>
            </>
          ) : (
            <div className="text-sm text-muted-foreground">
              {t("connect.status.noKeyYet")}
            </div>
          )}
        </div>
      ) : null}

      {hasTreasury && (hasKey ? <RotateKeyButton /> : <IssueKeyButton />)}
    </div>
  );
}

function IssueKeyButton() {
  const t = useTranslations("fund.settings.citizenpay");
  // Plain <a> (not next/link) — `/api/citizenpay/connect` has GET side
  // effects (mints a state row + 302s to CP), and <Link>'s default
  // prefetch would burn one state token per settings-page view.
  return (
    <a
      href="/api/citizenpay/connect"
      className={buttonVariants({ variant: "default" })}
    >
      <ExternalLink className="size-4" />
      {t("connect.issueKey")}
    </a>
  );
}

function RotateKeyButton() {
  const t = useTranslations("fund.settings.citizenpay");
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline">
            <KeyRound className="size-4" />
            {t("connect.rotateKey")}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("connect.rotateConfirm.title")}</DialogTitle>
          <DialogDescription>
            {t("connect.rotateConfirm.description")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            {t("connect.rotateConfirm.cancel")}
          </Button>
          <a
            href="/api/citizenpay/connect"
            className={buttonVariants({ variant: "default" })}
          >
            {t("connect.rotateConfirm.confirm")}
          </a>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConnectFlash({ flash }: { flash: string | null }) {
  const t = useTranslations("fund.settings.citizenpay");
  if (!flash) return null;
  if (flash === SUCCESS_CODE) {
    return (
      <Alert>
        <CheckCircle2 className="size-4" />
        <AlertDescription>{t("connect.flash.ok")}</AlertDescription>
      </Alert>
    );
  }
  if (flash === "not_configured") {
    return (
      <Alert variant="destructive">
        <AlertDescription>{t("connect.flash.notConfigured")}</AlertDescription>
      </Alert>
    );
  }
  if (flash === "not_connected") {
    return (
      <Alert variant="destructive">
        <AlertDescription>{t("connect.flash.notConnected")}</AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant="destructive">
      <AlertDescription>
        {t("connect.flash.failed")}
        {KNOWN_USER_ERRORS.has(flash) ? (
          <span className="ml-2 text-xs opacity-70 font-mono">[{flash}]</span>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}
