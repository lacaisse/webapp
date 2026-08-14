// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
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
  archiveTierAction,
  createTierAction,
  updateTierAction,
} from "@/services/allocation-tiers/admin-actions";

type Mode =
  | { kind: "create" }
  | {
      kind: "edit";
      tierId: string;
      initial: {
        name: string;
        minContribution: string;
        allocationAmount: string;
        maxContribution: string;
        position: number;
        hiddenAtSignup: boolean;
      };
    };

export function TierDialog({
  mode,
  trigger,
}: {
  mode: Mode;
  trigger: React.ReactNode;
}) {
  const t = useTranslations("fund.allocations.tiers.dialog");
  const tRoot = useTranslations();
  const initial =
    mode.kind === "edit"
      ? mode.initial
      : {
          name: "",
          minContribution: "",
          allocationAmount: "",
          maxContribution: "",
          position: 0,
          hiddenAtSignup: false,
        };

  const [open, setOpen] = useState(false);
  const [name, setName] = useState(initial.name);
  const [minC, setMinC] = useState(initial.minContribution);
  const [alloc, setAlloc] = useState(initial.allocationAmount);
  const [maxC, setMaxC] = useState(initial.maxContribution);
  const [position, setPosition] = useState(initial.position);
  const [hiddenAtSignup, setHiddenAtSignup] = useState(initial.hiddenAtSignup);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onSubmit = () => {
    setError(null);
    startTransition(async () => {
      const data = {
        name,
        minContribution: minC,
        allocationAmount: alloc,
        maxContribution: maxC,
        position,
        hiddenAtSignup,
      };
      const result =
        mode.kind === "create"
          ? await createTierAction(data)
          : await updateTierAction({ tierId: mode.tierId, data });
      if ("error" in result) {
        const msg = result.error.startsWith("tiers.")
          ? tRoot(result.error as never)
          : result.error;
        setError(msg);
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
        <div className="space-y-3">
          <FieldInput
            id="tier-name"
            label={t("name")}
            value={name}
            onChange={setName}
            required
          />
          <div className="grid grid-cols-3 gap-3">
            <FieldInput
              id="tier-min"
              label={t("min")}
              value={minC}
              onChange={setMinC}
              required
              inputMode="decimal"
            />
            <FieldInput
              id="tier-alloc"
              label={t("allocation")}
              value={alloc}
              onChange={setAlloc}
              required
              inputMode="decimal"
            />
            <FieldInput
              id="tier-max"
              label={t("max")}
              value={maxC}
              onChange={setMaxC}
              required
              inputMode="decimal"
            />
          </div>
          <FieldInput
            id="tier-position"
            label={t("position")}
            value={String(position)}
            onChange={(v) => setPosition(Number.parseInt(v) || 0)}
            inputMode="numeric"
          />
          <div className="flex items-start gap-3">
            <Checkbox
              id="tier-hidden"
              checked={hiddenAtSignup}
              onCheckedChange={(checked) => setHiddenAtSignup(checked === true)}
            />
            <div className="space-y-1">
              <Label htmlFor="tier-hidden" className="font-normal">
                {t("hiddenAtSignup")}
              </Label>
              <p className="text-xs text-muted-foreground">
                {t("hiddenAtSignupHint")}
              </p>
            </div>
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

export function ArchiveTierButton({ tierId }: { tierId: string }) {
  const t = useTranslations("fund.allocations.tiers.archive");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const onConfirm = () => {
    setError(null);
    startTransition(async () => {
      const result = await archiveTierAction({ tierId });
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
        render={<Button variant="ghost" size="sm">{t("button")}</Button>}
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
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
            variant="destructive"
            onClick={onConfirm}
            disabled={pending}
          >
            {pending ? t("archiving") : t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FieldInput({
  id,
  label,
  value,
  onChange,
  required,
  inputMode,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  required?: boolean;
  inputMode?: "decimal" | "numeric";
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>
        {label}
        {required && (
          <span className="ml-1 text-destructive" aria-hidden>
            *
          </span>
        )}
      </Label>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode={inputMode}
        autoComplete="off"
      />
    </div>
  );
}
