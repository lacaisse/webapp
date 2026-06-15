// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { Loader2, RotateCcw } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState, useTransition } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  previewEmailTemplateAction,
  resetEmailTemplateAction,
  saveEmailTemplateAction,
} from "@/services/email/template-actions";

// Editor for the per-fund ALLOCATION_CONFIRMATION email override. Subject + a
// rich-HTML body (source), with a live preview rendered server-side in the
// fund's branded shell using sample values. Validation re-runs server-side and
// any error string comes back translated. "Reset to default" drops the
// override and restores the built-in wording.
export function AllocationTemplateForm({
  initial,
  base,
  hasOverride,
  variables,
}: {
  initial: { subject: string; bodyHtml: string };
  base: { subject: string; bodyHtml: string };
  hasOverride: boolean;
  variables: readonly string[];
}) {
  const t = useTranslations("fund.settings.emailTemplates");
  const tRoot = useTranslations("fund.settings");

  const [subject, setSubject] = useState(initial.subject);
  const [bodyHtml, setBodyHtml] = useState(initial.bodyHtml);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [overridden, setOverridden] = useState(hasOverride);
  const [pending, startTransition] = useTransition();
  const [resetting, startReset] = useTransition();

  // Debounced live preview (server-rendered branded HTML).
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const handle = setTimeout(async () => {
      setPreviewing(true);
      const result = await previewEmailTemplateAction({
        type: "ALLOCATION_CONFIRMATION",
        subject,
        bodyHtml,
      });
      if (cancelled) return;
      if ("ok" in result) setPreviewHtml(result.html);
      setPreviewing(false);
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [subject, bodyHtml]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await saveEmailTemplateAction({
        type: "ALLOCATION_CONFIRMATION",
        subject,
        bodyHtml,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setSaved(true);
      setOverridden(true);
    });
  };

  const onReset = () => {
    setError(null);
    setSaved(false);
    startReset(async () => {
      const result = await resetEmailTemplateAction({
        type: "ALLOCATION_CONFIRMATION",
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setSubject(base.subject);
      setBodyHtml(base.bodyHtml);
      setOverridden(false);
    });
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Editor column */}
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="alloc-template-subject">{t("subjectLabel")}</Label>
            <Input
              id="alloc-template-subject"
              value={subject}
              onChange={(e) => {
                setSaved(false);
                setSubject(e.target.value);
              }}
              autoComplete="off"
              spellCheck={false}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="alloc-template-body">{t("htmlLabel")}</Label>
            <textarea
              id="alloc-template-body"
              value={bodyHtml}
              onChange={(e) => {
                setSaved(false);
                setBodyHtml(e.target.value);
              }}
              rows={14}
              spellCheck={false}
              className="w-full rounded-md bg-background px-2.5 py-1.5 font-mono text-xs ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <p className="text-xs text-muted-foreground">{t("htmlHint")}</p>
          </div>

          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">{t("variablesHint")}</p>
            <div className="flex flex-wrap gap-1.5">
              {variables.map((v) => (
                <span
                  key={v}
                  title={t(`variables.${v}` as never)}
                  className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
                >
                  {`{${v}}`}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* Preview column */}
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <Label>{t("previewLabel")}</Label>
            {previewing && (
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" />
            )}
          </div>
          <div className="overflow-hidden rounded-md border border-border">
            <div className="border-b border-border bg-muted/40 px-3 py-2 text-xs">
              <span className="text-muted-foreground">{t("previewSubject")} </span>
              <span className="font-medium">{subject}</span>
            </div>
            <iframe
              title={t("previewLabel")}
              sandbox=""
              srcDoc={previewHtml ?? ""}
              className="h-[460px] w-full bg-white"
            />
          </div>
        </div>
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex items-center justify-between gap-3">
        <div className="text-xs text-muted-foreground">
          {saved && !pending
            ? tRoot("saved")
            : overridden
              ? t("usingOverride")
              : t("usingDefault")}
        </div>
        <div className="flex items-center gap-2">
          {overridden && (
            <Dialog>
              <DialogTrigger
                render={
                  <Button type="button" variant="outline" disabled={resetting} />
                }
              >
                <RotateCcw className="size-3.5" />
                {t("reset")}
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>{t("resetConfirmTitle")}</DialogTitle>
                  <DialogDescription>
                    {t("resetConfirmDescription")}
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <DialogClose render={<Button type="button" variant="outline" />}>
                    {t("resetConfirmCancel")}
                  </DialogClose>
                  <DialogClose
                    render={
                      <Button
                        type="button"
                        variant="destructive"
                        onClick={onReset}
                      />
                    }
                  >
                    {t("resetConfirmConfirm")}
                  </DialogClose>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          )}
          <Button type="submit" disabled={pending}>
            {pending ? tRoot("saving") : tRoot("save")}
          </Button>
        </div>
      </div>
    </form>
  );
}
