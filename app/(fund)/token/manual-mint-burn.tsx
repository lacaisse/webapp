// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import {
  AlertTriangle,
  CheckCircle2,
  Coins,
  Flame,
  Loader2,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";
import { Controller, useForm } from "react-hook-form";

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
  manualBurnDirectAction,
  manualMintDirectAction,
} from "@/services/token-operations/admin-actions";
import {
  ManualBurnFormSchema,
  ManualMintFormSchema,
  type ManualBurnDirectInput,
  type ManualMintDirectInput,
} from "@/services/token-operations/schemas";

import {
  RecipientPicker,
  type RecipientPickerLabels,
} from "./recipient-picker";

// Admin mint/burn against a raw wallet address. Submits a UserOp through
// services/token-operations/admin-actions.ts → services/token/userop.ts.
// The dialog itself doubles as the confirmation step for burn — the
// destructive button is only inside, not on the page surface.

export function ManualMintButton({ symbol }: { symbol: string | null }) {
  return <MintDialog symbol={symbol} />;
}

export function ManualBurnButton({ symbol }: { symbol: string | null }) {
  return <BurnDialog symbol={symbol} />;
}

function MintDialog({ symbol }: { symbol: string | null }) {
  const t = useTranslations("fund.token.manual.mint");
  const tRoot = useTranslations();
  const pickerLabels = useRecipientPickerLabels("to");
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [txHash, setTxHash] = useState<string | null>(null);

  const form = useForm<ManualMintDirectInput>({
    resolver: zodResolver(ManualMintFormSchema),
    defaultValues: { to: "", amount: "", note: "" },
  });
  const errors = form.formState.errors;

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      form.reset();
      setTxHash(null);
    }
  }

  const onSubmit = (data: ManualMintDirectInput) =>
    startTransition(async () => {
      const result = await manualMintDirectAction(data);
      if ("error" in result) {
        if (result.field) {
          form.setError(result.field, { message: result.error });
        } else {
          form.setError("root", { message: result.error });
        }
        return;
      }
      setTxHash(result.txHash);
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button variant="default">
            <Coins className="size-4" />
            {t("trigger")}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        {txHash ? (
          <SuccessPanel
            txHash={txHash}
            label={tRoot("fund.token.manual.success")}
            close={tRoot("common.cancel")}
            onClose={() => onOpenChange(false)}
          />
        ) : (
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <Controller
              control={form.control}
              name="to"
              render={({ field }) => (
                <RecipientPicker
                  id="manual-mint-to"
                  labels={pickerLabels}
                  value={field.value}
                  onChange={field.onChange}
                  error={translateError(tRoot, errors.to?.message)}
                />
              )}
            />
            <AmountField
              id="manual-mint-amount"
              label={t("amountLabel")}
              symbol={symbol}
              register={form.register("amount")}
              error={translateError(tRoot, errors.amount?.message)}
            />
            <NoteField
              id="manual-mint-note"
              label={t("noteLabel")}
              placeholder={t("notePlaceholder")}
              register={form.register("note")}
              error={translateError(tRoot, errors.note?.message)}
            />
            {errors.root && (
              <Alert variant="destructive">
                <AlertDescription>{errors.root.message}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
              >
                {tRoot("common.cancel")}
              </Button>
              <Button type="submit" disabled={pending}>
                {pending && <Loader2 className="size-4 animate-spin" />}
                {t("submit")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function BurnDialog({ symbol }: { symbol: string | null }) {
  const t = useTranslations("fund.token.manual.burn");
  const tRoot = useTranslations();
  const pickerLabels = useRecipientPickerLabels("from");
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [txHash, setTxHash] = useState<string | null>(null);

  const form = useForm<ManualBurnDirectInput>({
    resolver: zodResolver(ManualBurnFormSchema),
    defaultValues: { from: "", amount: "", note: "" },
  });
  const errors = form.formState.errors;

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      form.reset();
      setTxHash(null);
    }
  }

  const onSubmit = (data: ManualBurnDirectInput) =>
    startTransition(async () => {
      const result = await manualBurnDirectAction(data);
      if ("error" in result) {
        if (result.field) {
          form.setError(result.field, { message: result.error });
        } else {
          form.setError("root", { message: result.error });
        }
        return;
      }
      setTxHash(result.txHash);
    });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={
          <Button variant="outline">
            <Flame className="size-4" />
            {t("trigger")}
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>

        {txHash ? (
          <SuccessPanel
            txHash={txHash}
            label={tRoot("fund.token.manual.success")}
            close={tRoot("common.cancel")}
            onClose={() => onOpenChange(false)}
          />
        ) : (
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <Alert variant="destructive">
              <AlertTriangle className="size-4" />
              <AlertDescription>{t("warning")}</AlertDescription>
            </Alert>
            <Controller
              control={form.control}
              name="from"
              render={({ field }) => (
                <RecipientPicker
                  id="manual-burn-from"
                  labels={pickerLabels}
                  value={field.value}
                  onChange={field.onChange}
                  error={translateError(tRoot, errors.from?.message)}
                />
              )}
            />
            <AmountField
              id="manual-burn-amount"
              label={t("amountLabel")}
              symbol={symbol}
              register={form.register("amount")}
              error={translateError(tRoot, errors.amount?.message)}
            />
            <NoteField
              id="manual-burn-note"
              label={t("noteLabel")}
              placeholder={t("notePlaceholder")}
              register={form.register("note")}
              error={translateError(tRoot, errors.note?.message)}
            />
            {errors.root && (
              <Alert variant="destructive">
                <AlertDescription>{errors.root.message}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
              >
                {tRoot("common.cancel")}
              </Button>
              <Button type="submit" variant="destructive" disabled={pending}>
                {pending && <Loader2 className="size-4 animate-spin" />}
                {t("submit")}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function useRecipientPickerLabels(
  direction: "to" | "from",
): RecipientPickerLabels {
  const t = useTranslations("fund.token.manual.picker");
  const tDir = useTranslations(
    direction === "to" ? "fund.token.manual.mint" : "fund.token.manual.burn",
  );
  return {
    field: tDir(direction === "to" ? "toLabel" : "fromLabel"),
    placeholder: t("placeholder"),
    searchHint: t("searchHint"),
    emptyHint: t("emptyHint"),
    searching: t("searching"),
    external: t("external"),
    externalWarning: t("externalWarning"),
    card: t("card"),
    place: t("place"),
    clear: t("clear"),
  };
}

function AmountField({
  id,
  label,
  symbol,
  register,
  error,
}: {
  id: string;
  label: string;
  symbol: string | null;
  register: ReturnType<ReturnType<typeof useForm>["register"]>;
  error: string | null;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <div className="flex items-center gap-2">
        <Input
          id={id}
          autoComplete="off"
          inputMode="decimal"
          placeholder="0.00"
          {...register}
        />
        {symbol && (
          <span className="text-sm text-muted-foreground whitespace-nowrap">
            {symbol}
          </span>
        )}
      </div>
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

// Required operator annotation — the audit note explaining why this manual
// mint/burn happened. Persisted as the transaction's annotation.
function NoteField({
  id,
  label,
  placeholder,
  register,
  error,
}: {
  id: string;
  label: string;
  placeholder: string;
  register: ReturnType<ReturnType<typeof useForm>["register"]>;
  error: string | null;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        autoComplete="off"
        placeholder={placeholder}
        maxLength={280}
        {...register}
      />
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

function SuccessPanel({
  txHash,
  label,
  close,
  onClose,
}: {
  txHash: string;
  label: string;
  close: string;
  onClose: () => void;
}) {
  return (
    <div className="space-y-4">
      <Alert>
        <CheckCircle2 className="size-4" />
        <AlertDescription>
          <div>{label}</div>
          <div className="mt-1 font-mono text-xs break-all">{txHash}</div>
        </AlertDescription>
      </Alert>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose}>
          {close}
        </Button>
      </DialogFooter>
    </div>
  );
}

// Server actions return either translated strings (for status errors) or
// i18n keys (for schema validation errors). Resolve the key path through
// the root translator the same way the create-fund-form does.
function translateError(
  t: ReturnType<typeof useTranslations>,
  msg: string | undefined,
): string | null {
  if (!msg) return null;
  if (msg.startsWith("tokenOps.") || msg.startsWith("funds.") || msg.startsWith("auth.")) {
    return t(msg as never);
  }
  return msg;
}
