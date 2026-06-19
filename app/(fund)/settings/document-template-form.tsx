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
import { Label } from "@/components/ui/label";
import {
  previewDocumentTemplateAction,
  resetDocumentTemplateAction,
  saveDocumentTemplateAction,
} from "@/services/document/actions";
import type { EditableDocumentType } from "@/services/document/config";

// Editor for a per-fund editable document template (markdown-ish body), with a
// live server-rendered PDF preview (sample data) in an iframe. Mirrors the
// email template editor but documents are a single body field and the preview
// is a rendered PDF rather than branded HTML. Validation re-runs server-side and
// any error string comes back translated.
export function DocumentTemplateForm({
  type,
  initial,
  base,
  hasOverride,
  variables,
}: {
  type: EditableDocumentType;
  initial: string;
  base: string;
  hasOverride: boolean;
  variables: readonly string[];
}) {
  const t = useTranslations("fund.settings.documentTemplates");
  const tRoot = useTranslations("fund.settings");

  const [body, setBody] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [overridden, setOverridden] = useState(hasOverride);
  const [pending, startTransition] = useTransition();
  const [resetting, startReset] = useTransition();

  // Debounced live PDF preview (sample data), rendered server-side and embedded
  // as a data URL.
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const handle = setTimeout(async () => {
      setPreviewing(true);
      const result = await previewDocumentTemplateAction({ type, body });
      if (cancelled) return;
      if ("ok" in result) setPreviewUrl(result.dataUrl);
      setPreviewing(false);
    }, 500);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [type, body]);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const result = await saveDocumentTemplateAction({ type, body });
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
      const result = await resetDocumentTemplateAction({ type });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setBody(base);
      setOverridden(false);
    });
  };

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Editor column */}
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor={`${type}-template-body`}>{t("bodyLabel")}</Label>
            <textarea
              id={`${type}-template-body`}
              value={body}
              onChange={(e) => {
                setSaved(false);
                setBody(e.target.value);
              }}
              rows={20}
              spellCheck={false}
              className="w-full rounded-md bg-background px-2.5 py-1.5 font-mono text-xs ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <p className="text-xs text-muted-foreground">{t("bodyHint")}</p>
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
                  {`{{${v}}}`}
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
          <iframe
            title={t("previewLabel")}
            src={previewUrl ?? ""}
            className="h-[560px] w-full rounded-md border border-border bg-white"
          />
          <p className="text-xs text-muted-foreground">{t("previewHint")}</p>
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
