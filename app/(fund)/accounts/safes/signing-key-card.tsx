// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { AlertTriangle, CheckCircle2, Fingerprint, Loader2, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useFormatter, useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { deploySigningPasskeyAction } from "@/services/safe/passkey-actions";

import type { SigningPasskeyStatus } from "./data";
import { SafeAddress } from "./safe-address";
import { RegisterSigningPasskeyButton } from "./signing-passkey-dialog";

// The current member's Safe signing passkey for this fund: register one,
// see whether it is backed up, replace it after a lost device (the Safes
// it still owns with the old key are listed — each needs a swap).
export function SigningKeyCard({
  status,
  hasPasskey,
}: {
  status: SigningPasskeyStatus | null;
  hasPasskey: boolean;
}) {
  const t = useTranslations("fund.safes.passkey");
  const format = useFormatter();
  const router = useRouter();
  const [deploying, startDeploy] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const onDeploy = () => {
    setError(null);
    startDeploy(async () => {
      const res = await deploySigningPasskeyAction();
      if ("error" in res) {
        setError(res.error);
        return;
      }
      router.refresh();
    });
  };

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Fingerprint className="size-4" />
          {t("cardTitle")}
        </CardTitle>
        <CardDescription>{t("cardDescription")}</CardDescription>
        <CardAction>
          {status ? (
            <RegisterSigningPasskeyButton replace hasPasskey={hasPasskey} variant="outline" />
          ) : (
            <RegisterSigningPasskeyButton replace={false} hasPasskey={hasPasskey} />
          )}
        </CardAction>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {status ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <SafeAddress address={status.address} />
              {status.backupState ? (
                <Badge variant="success">
                  <CheckCircle2 className="size-3" />
                  {t("backedUp")}
                </Badge>
              ) : (
                <Badge variant="warning">
                  <AlertTriangle className="size-3" />
                  {t("deviceOnly")}
                </Badge>
              )}
              {!status.deployed && <Badge variant="destructive">{t("notDeployed")}</Badge>}
            </div>
            <p className="text-xs text-muted-foreground">
              {t("registeredOn", {
                date: format.dateTime(new Date(status.createdAt), { dateStyle: "medium" }),
              })}
              {status.lastUsedAt &&
                ` · ${t("lastUsed", {
                  date: format.dateTime(new Date(status.lastUsedAt), { dateStyle: "medium", timeStyle: "short" }),
                })}`}
            </p>
            {!status.backupState && (
              <p className="text-xs text-muted-foreground">{t("deviceOnlyHint")}</p>
            )}
            {!status.deployed && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">{t("notDeployedHint")}</span>
                <Button type="button" size="xs" variant="outline" onClick={onDeploy} disabled={deploying}>
                  {deploying ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                  {t("retryDeploy")}
                </Button>
              </div>
            )}
            {status.staleOwnerSafes.length > 0 && (
              <Alert variant="warning">
                <AlertTriangle className="size-4" />
                <AlertDescription>
                  <p>{t("staleOwners", { count: status.staleOwnerSafes.length })}</p>
                  <ul className="mt-1 flex flex-wrap gap-2">
                    {status.staleOwnerSafes.map((s) => (
                      <li key={s.id}>
                        <Link href={`/accounts/safes/${s.id}?tab=signers`} className="underline underline-offset-2">
                          {s.name}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}
          </>
        ) : (
          <p className="text-muted-foreground">{t("none")}</p>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
