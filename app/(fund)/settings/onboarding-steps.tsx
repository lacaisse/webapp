// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableEmpty,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  archiveOnboardingStepAction,
  createOnboardingStepAction,
  restoreOnboardingStepAction,
  updateOnboardingStepAction,
} from "@/services/onboarding/admin-actions";
import type { StepData } from "@/services/onboarding/schema";

// Steps split the public signup form into pages. A fund with no steps keeps
// the single-page form, so this list is empty by default and adding the first
// step is what turns the stepper on.

export type StepRow = {
  id: string;
  title: string;
  description: string | null;
  position: number;
  archivedAt: Date | null;
  fieldCount: number;
};

export function OnboardingSteps({
  target,
  steps,
}: {
  target: "MEMBER" | "MERCHANT";
  steps: StepRow[];
}) {
  const t = useTranslations("fund.settings.onboarding.steps");

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="space-y-0.5">
          <h3 className="text-sm font-medium">
            {t(target === "MEMBER" ? "memberTitle" : "merchantTitle")}
          </h3>
          <p className="text-xs text-muted-foreground">{t("description")}</p>
        </div>
        <StepDialog
          target={target}
          trigger={
            <Button variant="default" size="sm">
              {t("add")}
            </Button>
          }
        />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("columns.position")}</TableHead>
            <TableHead>{t("columns.title")}</TableHead>
            <TableHead>{t("columns.fields")}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {steps.length === 0 ? (
            <TableEmpty colSpan={4}>{t("empty")}</TableEmpty>
          ) : (
            steps.map((s) => (
              <TableRow key={s.id}>
                <TableCell className="text-sm text-muted-foreground">
                  {s.position}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-medium">{s.title}</span>
                    {s.archivedAt && (
                      <Badge variant="default">{t("archived")}</Badge>
                    )}
                  </div>
                  {s.description && (
                    <div className="text-xs text-muted-foreground">
                      {s.description}
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {t("fieldCount", { count: s.fieldCount })}
                </TableCell>
                <TableCell className="text-right">
                  <div className="inline-flex items-center gap-1">
                    <StepDialog
                      target={target}
                      edit={s}
                      trigger={
                        <Button variant="ghost" size="sm">
                          {t("edit")}
                        </Button>
                      }
                    />
                    <ArchiveButton step={s} />
                  </div>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

function StepDialog({
  target,
  edit,
  trigger,
}: {
  target: "MEMBER" | "MERCHANT";
  edit?: StepRow;
  trigger: React.ReactNode;
}) {
  const t = useTranslations("fund.settings.onboarding.steps.dialog");
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(edit?.title ?? "");
  const [description, setDescription] = useState(edit?.description ?? "");
  const [position, setPosition] = useState(edit?.position ?? 0);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const reset = () => {
    if (edit) return;
    setTitle("");
    setDescription("");
    setPosition(0);
    setError(null);
  };

  const onSubmit = () => {
    setError(null);
    startTransition(async () => {
      const data: StepData = {
        title: title.trim(),
        description: description.trim() || null,
        position,
      };
      const result = edit
        ? await updateOnboardingStepAction({ stepId: edit.id, data })
        : await createOnboardingStepAction({ target, data });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpen(false);
      reset();
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger render={trigger as React.ReactElement} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{edit ? t("editTitle") : t("createTitle")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="step-title">
              {t("title")}
              <span className="ml-1 text-destructive" aria-hidden>
                *
              </span>
            </Label>
            <Input
              id="step-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground">{t("titleHint")}</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="step-description">{t("stepDescription")}</Label>
            <Input
              id="step-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="step-position">{t("position")}</Label>
            <Input
              id="step-position"
              value={String(position)}
              onChange={(e) =>
                setPosition(Number.parseInt(e.target.value) || 0)
              }
              inputMode="numeric"
            />
            <p className="text-xs text-muted-foreground">{t("positionHint")}</p>
          </div>
        </div>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            {t("cancel")}
          </Button>
          <Button onClick={onSubmit} disabled={pending}>
            {pending ? t("saving") : t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ArchiveButton({ step }: { step: StepRow }) {
  const t = useTranslations("fund.settings.onboarding.steps.archive");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const isArchived = step.archivedAt !== null;

  const onConfirm = () => {
    setError(null);
    startTransition(async () => {
      const result = isArchived
        ? await restoreOnboardingStepAction({ stepId: step.id })
        : await archiveOnboardingStepAction({ stepId: step.id });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpen(false);
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="ghost" size="sm">
            {isArchived ? t("restore") : t("button")}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isArchived ? t("restoreTitle") : t("title")}
          </DialogTitle>
          <DialogDescription>
            {isArchived ? t("restoreDescription") : t("description")}
          </DialogDescription>
        </DialogHeader>
        {/* Archiving never orphans an answer: the step's fields fall back to
            the first page of the form rather than disappearing. */}
        {!isArchived && step.fieldCount > 0 && (
          <Alert>
            <AlertDescription>
              {t("fieldsMove", { count: step.fieldCount })}
            </AlertDescription>
          </Alert>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={pending}
          >
            {t("cancel")}
          </Button>
          <Button
            variant={isArchived ? "default" : "destructive"}
            onClick={onConfirm}
            disabled={pending}
          >
            {pending
              ? t("saving")
              : isArchived
                ? t("restoreConfirm")
                : t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
