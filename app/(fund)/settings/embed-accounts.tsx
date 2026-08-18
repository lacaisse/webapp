// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/copy-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  rotateAccountEmbedSlugAction,
  setAccountEmbedAction,
} from "@/services/embed/admin-actions";
import { EMBED_HEIGHTS, buildEmbedSnippet } from "./embed-snippet";

// Per-account controls for the public account widget.
//
// Enabling is a one-click, non-destructive action. Disabling and rotating both
// break every URL already pasted into a website, so each goes through an in-app
// confirmation dialog — the repo forbids confirm(), and these are exactly the
// "irreversible from the visitor's side" changes that rule exists for.

export type EmbedAccountRow = {
  id: string;
  name: string;
  embedSlug: string | null;
};

export function EmbedAccounts({
  accounts,
  baseUrl,
  fundName,
}: {
  accounts: EmbedAccountRow[];
  baseUrl: string;
  fundName: string;
}) {
  const t = useTranslations("fund.settings.embeds.accounts");

  if (accounts.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("none")}</p>;
  }

  return (
    <ul className="divide-y">
      {accounts.map((account) => (
        <AccountRow
          key={account.id}
          account={account}
          baseUrl={baseUrl}
          fundName={fundName}
        />
      ))}
    </ul>
  );
}

function AccountRow({
  account,
  baseUrl,
  fundName,
}: {
  account: EmbedAccountRow;
  baseUrl: string;
  fundName: string;
}) {
  const t = useTranslations("fund.settings.embeds.accounts");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [confirming, setConfirming] = useState<"disable" | "rotate" | null>(
    null,
  );

  const enabled = account.embedSlug !== null;
  const snippet = account.embedSlug
    ? buildEmbedSnippet(
        `${baseUrl}/embed/account/${account.embedSlug}`,
        `${fundName} — ${account.name}`,
        EMBED_HEIGHTS.account,
      )
    : null;

  function run(action: () => Promise<{ ok: true } | { error: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if ("error" in result) setError(result.error);
      setConfirming(null);
    });
  }

  return (
    <li className="space-y-2 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">{account.name}</span>
        <div className="flex items-center gap-1.5">
          {enabled ? (
            <>
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => setConfirming("rotate")}
              >
                {t("rotate")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={pending}
                onClick={() => setConfirming("disable")}
              >
                {t("disable")}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                run(() =>
                  setAccountEmbedAction({
                    accountId: account.id,
                    enabled: true,
                  }),
                )
              }
            >
              {t("enable")}
            </Button>
          )}
        </div>
      </div>

      {snippet ? (
        <div className="space-y-1">
          <div className="text-xs text-muted-foreground">
            {t("snippetLabel")}
          </div>
          <div className="flex items-start gap-2">
            <code className="flex-1 overflow-x-auto rounded-md bg-muted px-2.5 py-1.5 font-mono text-xs break-all whitespace-pre-wrap">
              {snippet}
            </code>
            <CopyButton value={snippet} />
          </div>
        </div>
      ) : null}

      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Dialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) setConfirming(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {confirming === "rotate"
                ? t("rotateConfirm.title")
                : t("disableConfirm.title")}
            </DialogTitle>
            <DialogDescription>
              {confirming === "rotate"
                ? t("rotateConfirm.body")
                : t("disableConfirm.body")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(null)}>
              {t("cancel")}
            </Button>
            <Button
              variant="default"
              disabled={pending}
              onClick={() =>
                run(() =>
                  confirming === "rotate"
                    ? rotateAccountEmbedSlugAction({ accountId: account.id })
                    : setAccountEmbedAction({
                        accountId: account.id,
                        enabled: false,
                      }),
                )
              }
            >
              {confirming === "rotate" ? t("rotate") : t("disable")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </li>
  );
}
