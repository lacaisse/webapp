// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Building2, Landmark, Loader2, Search } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useMemo, useState, useTransition } from "react";
import { useForm, useWatch } from "react-hook-form";
import { z } from "zod";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { parseTopUpAmount } from "@/services/card-topup/amount";

import { startCardTopUpAction } from "./actions";

export type TopUpBankOption = {
  id: string;
  name: string;
  logoUrl: string | null;
  requiresDebtorIban: boolean;
};

// Client-side mirror of StartCardTopUpSchema (the action re-validates).
// Messages are i18n keys.
const FormSchema = z.object({
  amount: z.string().superRefine((value, ctx) => {
    const parsed = parseTopUpAmount(value);
    if (!parsed.ok) ctx.addIssue({ code: "custom", message: parsed.error });
  }),
  bankId: z.string().min(1, { error: "cotisation.topUp.errors.bankRequired" }),
  iban: z.string(),
});
type FormValues = z.infer<typeof FormSchema>;

// Show a search box once the list is long enough to need one.
const BANK_SEARCH_THRESHOLD = 8;

export function TopUpForm({
  serial,
  presetsCents,
  amountHint,
  banks,
}: {
  serial: string;
  presetsCents: number[];
  amountHint: string;
  banks: TopUpBankOption[];
}) {
  const t = useTranslations("cotisation.topUp");
  const tRoot = useTranslations();
  const format = useFormatter();
  const [pending, startTransition] = useTransition();
  const [redirecting, setRedirecting] = useState(false);
  const [query, setQuery] = useState("");

  const form = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: { amount: "", bankId: "", iban: "" },
  });
  const errors = form.formState.errors;
  const amountText = useWatch({ control: form.control, name: "amount" });
  const bankId = useWatch({ control: form.control, name: "bankId" });

  const parsedAmount = parseTopUpAmount(amountText);
  const amountCents = parsedAmount.ok ? parsedAmount.cents : null;
  const selectedBank = banks.find((b) => b.id === bankId) ?? null;

  const money = (cents: number) =>
    format.number(cents / 100, {
      style: "currency",
      currency: "EUR",
      minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    });

  const visibleBanks = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? banks.filter((b) => b.name.toLowerCase().includes(q)) : banks;
  }, [banks, query]);

  const translate = (msg: string | undefined) =>
    msg ? tRoot(msg as never) : null;

  const onSubmit = (values: FormValues) => {
    const parsed = parseTopUpAmount(values.amount);
    if (!parsed.ok) return;
    if (selectedBank?.requiresDebtorIban && !values.iban.trim()) {
      form.setError("iban", { message: "cotisation.topUp.errors.ibanRequired" });
      return;
    }
    startTransition(async () => {
      const result = await startCardTopUpAction({
        serial,
        amountCents: parsed.cents,
        bankId: values.bankId,
        iban: selectedBank?.requiresDebtorIban ? values.iban : undefined,
      });
      if ("error" in result) {
        // Already translated by the action.
        const field =
          result.field === "amount"
            ? "amount"
            : result.field === "bank"
              ? "bankId"
              : result.field === "iban"
                ? "iban"
                : "root";
        form.setError(field, { message: result.error, type: "server" });
        return;
      }
      setRedirecting(true);
      window.location.assign(result.url);
    });
  };

  // Server errors arrive translated; schema errors are keys.
  const message = (e: { message?: string; type?: string | number } | undefined) =>
    e?.type === "server" ? (e.message ?? null) : translate(e?.message);

  const busy = pending || redirecting;

  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6" noValidate>
      {/* Amount */}
      <fieldset className="space-y-3" disabled={busy}>
        <legend className="text-sm font-medium">{t("amount")}</legend>
        <div className="grid grid-cols-4 gap-2">
          {presetsCents.map((cents) => {
            const active = amountCents === cents;
            return (
              <button
                key={cents}
                type="button"
                aria-pressed={active}
                onClick={() =>
                  form.setValue("amount", String(cents / 100), {
                    shouldValidate: true,
                  })
                }
                className={cn(
                  "h-11 rounded-lg border text-base font-semibold transition-colors",
                  "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                  active
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-input bg-background hover:bg-muted",
                )}
              >
                {money(cents)}
              </button>
            );
          })}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="topup-amount">{t("customAmount")}</Label>
          <div className="relative">
            <span className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-sm text-muted-foreground">
              €
            </span>
            <Input
              id="topup-amount"
              inputMode="decimal"
              autoComplete="off"
              placeholder={t("customPlaceholder")}
              className="h-10 pl-7"
              aria-invalid={!!errors.amount}
              aria-describedby="topup-amount-hint"
              {...form.register("amount")}
            />
          </div>
          {errors.amount ? (
            <p className="text-sm text-destructive">{message(errors.amount)}</p>
          ) : (
            <p id="topup-amount-hint" className="text-xs text-muted-foreground">
              {amountHint}
            </p>
          )}
        </div>
      </fieldset>

      {/* Bank */}
      <fieldset className="space-y-3" disabled={busy}>
        <legend className="text-sm font-medium">{t("bank")}</legend>
        {banks.length > BANK_SEARCH_THRESHOLD && (
          <div className="relative">
            <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("bank")}
              aria-label={t("bank")}
              className="h-9 pl-8"
            />
          </div>
        )}
        <div
          role="radiogroup"
          aria-label={t("bank")}
          className="grid max-h-80 grid-cols-2 gap-2 overflow-y-auto p-0.5 sm:grid-cols-3"
        >
          {visibleBanks.map((bank) => {
            const active = bank.id === bankId;
            return (
              <button
                key={bank.id}
                type="button"
                role="radio"
                aria-checked={active}
                aria-label={bank.name}
                onClick={() =>
                  form.setValue("bankId", bank.id, { shouldValidate: true })
                }
                className={cn(
                  "flex h-14 items-center gap-2 rounded-lg border px-2.5 text-left text-sm transition-colors",
                  "focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
                  active
                    ? "border-primary bg-primary/5 ring-1 ring-primary"
                    : "border-input bg-background hover:bg-muted",
                )}
              >
                {bank.logoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={bank.logoUrl}
                    alt=""
                    className="size-8 shrink-0 rounded object-contain"
                    loading="lazy"
                  />
                ) : (
                  <Building2 className="size-6 shrink-0 text-muted-foreground" />
                )}
                <span className="line-clamp-2 font-medium">{bank.name}</span>
              </button>
            );
          })}
        </div>
        {errors.bankId ? (
          <p className="text-sm text-destructive">{message(errors.bankId)}</p>
        ) : (
          <p className="text-xs text-muted-foreground">{t("bankHint")}</p>
        )}

        {selectedBank?.requiresDebtorIban && (
          <div className="space-y-1.5">
            <Label htmlFor="topup-iban">{t("iban")}</Label>
            <Input
              id="topup-iban"
              autoComplete="off"
              spellCheck={false}
              placeholder="BE00 0000 0000 0000"
              className="h-10 font-mono uppercase"
              aria-invalid={!!errors.iban}
              {...form.register("iban")}
            />
            {errors.iban ? (
              <p className="text-sm text-destructive">{message(errors.iban)}</p>
            ) : (
              <p className="text-xs text-muted-foreground">
                {t("ibanHint", { bank: selectedBank.name })}
              </p>
            )}
          </div>
        )}
      </fieldset>

      {errors.root && (
        <Alert variant="destructive">
          <AlertDescription>{message(errors.root)}</AlertDescription>
        </Alert>
      )}

      <Button type="submit" className="h-11 w-full text-base" disabled={busy}>
        {busy ? (
          <>
            <Loader2 className="size-4 animate-spin" />
            {t("redirecting")}
          </>
        ) : (
          <>
            <Landmark className="size-4" />
            {amountCents != null
              ? t("submit", { amount: money(amountCents) })
              : t("submitNoAmount")}
          </>
        )}
      </Button>
    </form>
  );
}
