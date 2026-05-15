// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

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

type EmailRow = {
  id: string;
  type: string;
  toEmail: string;
  subject: string;
  status: "QUEUED" | "SENT" | "FAILED";
  errorMessage: string | null;
  resendMessageId: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  queuedAt: string;
  sentAt: string | null;
  failedAt: string | null;
};

export function EmailDetailDialog({ email }: { email: EmailRow }) {
  const t = useTranslations("fund.emails.detail");
  const [view, setView] = useState<"text" | "html">("text");

  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button variant="ghost" size="sm">
            {t("button")}
          </Button>
        }
      />
      <DialogContent className="max-w-2xl sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{email.subject}</DialogTitle>
          <DialogDescription>
            <code className="text-xs">{email.type}</code> · {email.toEmail}
          </DialogDescription>
        </DialogHeader>

        <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-xs">
          <dt className="text-muted-foreground">{t("status")}</dt>
          <dd>{email.status}</dd>
          <dt className="text-muted-foreground">{t("queuedAt")}</dt>
          <dd className="font-mono">{email.queuedAt}</dd>
          {email.sentAt && (
            <>
              <dt className="text-muted-foreground">{t("sentAt")}</dt>
              <dd className="font-mono">{email.sentAt}</dd>
            </>
          )}
          {email.failedAt && (
            <>
              <dt className="text-muted-foreground">{t("failedAt")}</dt>
              <dd className="font-mono">{email.failedAt}</dd>
            </>
          )}
          {email.resendMessageId && (
            <>
              <dt className="text-muted-foreground">{t("resendId")}</dt>
              <dd className="font-mono">{email.resendMessageId}</dd>
            </>
          )}
        </dl>

        {email.errorMessage && (
          <Alert variant="destructive">
            <AlertDescription>{email.errorMessage}</AlertDescription>
          </Alert>
        )}

        {(email.bodyText || email.bodyHtml) && (
          <div className="space-y-2">
            <div className="inline-flex gap-0.5 rounded-md bg-muted p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setView("text")}
                className={
                  view === "text"
                    ? "h-6 rounded-sm bg-background px-2 font-medium"
                    : "h-6 px-2 text-muted-foreground"
                }
              >
                {t("viewText")}
              </button>
              <button
                type="button"
                onClick={() => setView("html")}
                className={
                  view === "html"
                    ? "h-6 rounded-sm bg-background px-2 font-medium"
                    : "h-6 px-2 text-muted-foreground"
                }
              >
                {t("viewHtml")}
              </button>
            </div>
            {view === "text" ? (
              <pre className="max-h-72 overflow-auto rounded-md bg-muted p-3 text-xs whitespace-pre-wrap">
                {email.bodyText ?? t("noBody")}
              </pre>
            ) : email.bodyHtml ? (
              // Rendered HTML body. Senders we generate are trusted (our own
              // templates), but use sandbox + srcDoc to be safe regardless.
              <iframe
                title={t("viewHtml")}
                sandbox=""
                srcDoc={email.bodyHtml}
                className="h-72 w-full rounded-md border border-border bg-background"
              />
            ) : (
              <p className="text-xs text-muted-foreground">{t("noBody")}</p>
            )}
          </div>
        )}

        <DialogFooter showCloseButton />
      </DialogContent>
    </Dialog>
  );
}
