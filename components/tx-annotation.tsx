// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { Check, Loader2, Pencil } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { annotateTransactionAction } from "@/services/transaction-annotation/actions";

// A transaction's annotation: the resolved label (custom note, else localised
// system kind) plus an inline editor to set/clear the note. Holds the note in
// local state so the label updates immediately in client-paginated tables, not
// only on a server re-render. The mint/burn audit (who/what triggered the op)
// is surfaced separately by `TxTriggerCell`.
export function TxAnnotationCell({
  txHash,
  kind,
  note: initialNote,
}: {
  txHash: string;
  kind: string | null;
  note: string | null;
}) {
  const t = useTranslations("fund.annotations");
  const [note, setNote] = useState<string | null>(initialNote);

  const label = note?.trim()
    ? note.trim()
    : kind && t.has(kind as never)
      ? t(kind as never)
      : null;

  return (
    <div className="flex items-center gap-1.5">
      {label ? (
        <span className="text-xs text-foreground/70">{label}</span>
      ) : (
        <span className="text-xs text-muted-foreground/40">—</span>
      )}
      <AnnotateDialog txHash={txHash} note={note} onSaved={setNote} />
    </div>
  );
}

// The mint/burn audit cell: what triggered the on-chain op (a localised
// ANNOTATION_TRIGGERS label) and who fired it — the acting admin's name, or
// "System" for cron-driven ops. Read-only; empty ("—") for transfers with no
// recorded trigger (e.g. inbound transfers or pre-audit history).
export function TxTriggerCell({
  trigger,
  triggeredBy,
}: {
  trigger: string | null;
  triggeredBy: string | null;
}) {
  const t = useTranslations("fund.annotations");

  if (!trigger) {
    return <span className="text-xs text-muted-foreground/40">—</span>;
  }

  const triggerLabel = t.has(`triggers.${trigger}` as never)
    ? t(`triggers.${trigger}` as never)
    : trigger;
  const actor = triggeredBy ? t("by", { name: triggeredBy }) : t("system");

  return (
    <div className="flex flex-col">
      <span className="text-xs text-foreground/70">{triggerLabel}</span>
      <span className="text-[10px] text-muted-foreground/60">{actor}</span>
    </div>
  );
}

function AnnotateDialog({
  txHash,
  note,
  onSaved,
}: {
  txHash: string;
  note: string | null;
  onSaved: (next: string | null) => void;
}) {
  const t = useTranslations("fund.annotations");
  const tRoot = useTranslations();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(note ?? "");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setDraft(note ?? "");
      setError(null);
    }
  }

  const onSave = () => {
    setError(null);
    startTransition(async () => {
      const res = await annotateTransactionAction({ txHash, note: draft });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      onSaved(draft.trim() || null);
      setOpen(false);
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground/60 hover:text-foreground"
            aria-label={t("edit")}
          >
            <Pencil className="size-3.5" />
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="font-mono text-xs break-all text-muted-foreground">
            {txHash}
          </p>
          <div className="space-y-2">
            <Label htmlFor={`note-${txHash}`}>{t("noteLabel")}</Label>
            <Input
              id={`note-${txHash}`}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={t("notePlaceholder")}
              autoComplete="off"
              maxLength={280}
            />
          </div>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            {tRoot("common.cancel")}
          </Button>
          <Button type="button" onClick={onSave} disabled={pending}>
            {pending ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Check className="size-4" />
            )}
            {tRoot("common.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
