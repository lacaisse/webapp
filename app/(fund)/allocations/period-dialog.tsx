// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  createPeriodAction,
  updatePeriodAction,
} from "@/services/allocation-periods/admin-actions";

type Mode =
  | { kind: "create" }
  | { kind: "edit"; periodId: string; initialCutoff: string };

export function PeriodDialog({
  mode,
  trigger,
}: {
  mode: Mode;
  trigger: React.ReactNode;
}) {
  const t = useTranslations("fund.allocations.periods.dialog");
  const [open, setOpen] = useState(false);
  const [cutoff, setCutoff] = useState(
    mode.kind === "edit" ? mode.initialCutoff : "",
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onSubmit = () => {
    setError(null);
    startTransition(async () => {
      const result =
        mode.kind === "create"
          ? await createPeriodAction({ cutoffDate: cutoff })
          : await updatePeriodAction({
              periodId: mode.periodId,
              cutoffDate: cutoff,
            });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpen(false);
    });
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={trigger as React.ReactElement} />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {mode.kind === "create" ? t("createTitle") : t("editTitle")}
          </DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1">
          <Label htmlFor="period-cutoff">{t("cutoffDate")}</Label>
          <Input
            id="period-cutoff"
            type="date"
            value={cutoff}
            onChange={(e) => setCutoff(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">{t("cutoffHint")}</p>
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
          <Button onClick={onSubmit} disabled={pending || cutoff === ""}>
            {pending ? t("saving") : t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
