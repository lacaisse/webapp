// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { AlertTriangle, Info } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import type {
  PaymentSettingField,
  PaymentSettingValue,
  PaymentSettingView,
} from "@/services/citizenpay/payment-settings-rules";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  adoptPaymentSettingAction,
  applyPaymentSettingAction,
  updatePaymentSettingsAction,
  type PaymentSettingsResult,
} from "@/services/fund/settings-actions";
import {
  FEE_ACCOUNT_NONE,
  bpsToPercentInput,
  earlyPaidFromCents,
  sameAddress,
  type EarlyPaidMode,
  type FeeAccountOption,
} from "@/services/fund/payment-settings-schema";

// The payment settings applied on Citizen Pay on their own (citizenpay/api#277,
// #278): the fee account and the payout fee (Settings → Fees) and the instant
// terminal confirmation limit (Settings → Citizen Pay → Terminals). Each is
// its own small form calling updatePaymentSettingsAction with only its field.
// Under each, SettingNotice says how La Caisse's value compares with what
// Citizen Pay applies right now (read by the page on every view) and offers
// the explicit "apply" / "use Citizen Pay's value" actions: nothing reaches
// Citizen Pay any other way.

const selectClass =
  "h-8 w-full rounded-md bg-background px-2 text-sm ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring";

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

// Submit / pending / result plumbing shared by the three forms.
function useSave(onResult?: (r: PaymentSettingsResult) => void) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<PaymentSettingsResult | null>(null);
  const save = (run: () => Promise<PaymentSettingsResult>) => {
    setResult(null);
    startTransition(async () => {
      const r = await run();
      setResult(r);
      onResult?.(r);
    });
  };
  return { pending, result, save, clear: () => setResult(null) };
}

function ResultAlerts({ result }: { result: PaymentSettingsResult | null }) {
  if (!result) return null;
  if ("error" in result) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{result.error}</AlertDescription>
      </Alert>
    );
  }
  return (
    <>
      {result.warning && (
        <Alert variant="warning">
          <AlertTriangle className="size-4" />
          <AlertDescription>{result.warning}</AlertDescription>
        </Alert>
      )}
      {result.notice && (
        <Alert>
          <Info className="size-4" />
          <AlertDescription>{result.notice}</AlertDescription>
        </Alert>
      )}
    </>
  );
}

// How La Caisse's value compares with Citizen Pay's live one, and the two
// explicit ways to make them agree.
function SettingNotice({
  field,
  view,
  local,
  format,
}: {
  field: PaymentSettingField;
  view: PaymentSettingView;
  local: PaymentSettingValue;
  format: (v: PaymentSettingValue) => string;
}) {
  const t = useTranslations("fund.settings.paymentSync");
  const { pending, result, save } = useSave();
  if (view.state === "inSync") return null;
  const apply = () => save(() => applyPaymentSettingAction({ field }));
  const adopt = () => save(() => adoptPaymentSettingAction({ field }));
  return (
    <div className="space-y-2">
      <Alert variant={view.state === "drift" ? "warning" : "default"}>
        {view.state === "drift" ? <AlertTriangle className="size-4" /> : <Info className="size-4" />}
        <AlertDescription>
          {view.state === "drift"
            ? t("drift", { remote: format(view.remote), local: format(local) })
            : view.state === "notYetSupported"
              ? t("notYetSupported")
              : view.state === "unreadable"
                ? t("unreadable")
                : t("notConnected")}
        </AlertDescription>
      </Alert>
      {view.state === "drift" && (
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" disabled={pending} onClick={apply}>
            {t("applyLocal")}
          </Button>
          <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={adopt}>
            {t("useRemote")}
          </Button>
        </div>
      )}
      {view.state === "notYetSupported" && (
        // Enabled once the api knows the setting (the view then turns into
        // "drift" with its own buttons); shown so the way to apply is clear.
        <Button type="button" size="sm" variant="outline" disabled>
          {t("applyNow")}
        </Button>
      )}
      <ResultAlerts result={result} />
    </div>
  );
}

function SaveRow({
  pending,
  result,
}: {
  pending: boolean;
  result: PaymentSettingsResult | null;
}) {
  const t = useTranslations("fund.settings");
  return (
    <>
      <ResultAlerts result={result} />
      <div className="flex items-center justify-between">
        <div className="text-xs text-muted-foreground">
          {result && "ok" in result && !pending ? t("saved") : null}
        </div>
        <Button type="submit" disabled={pending}>
          {pending ? t("saving") : t("save")}
        </Button>
      </div>
    </>
  );
}

// --- Fee account ------------------------------------------------------------

export function FeeAccountForm({
  options,
  current,
  sweepDestination,
  view,
}: {
  // The fund's own eligible accounts (server-side list, main account first).
  options: FeeAccountOption[];
  current: string | null;
  // The payout sweep destination (the fund's main account).
  sweepDestination: string | null;
  view: PaymentSettingView;
}) {
  const t = useTranslations("fund.settings.fees.feeAccount");
  const [value, setValue] = useState(current ?? FEE_ACCOUNT_NONE);
  // A refused value is not kept: back to what Citizen Pay applies.
  const { pending, result, save, clear } = useSave((r) => {
    if ("ok" in r && r.revertedTo?.field === "feeAccountAddress") {
      setValue((r.revertedTo.value as string | null) ?? FEE_ACCOUNT_NONE);
    }
  });
  const formatAccount = (v: PaymentSettingValue) => {
    if (v === null) return t("none");
    const address = String(v);
    const option = options.find((o) => sameAddress(o.address, address));
    return option ? `${option.name} · ${shortAddress(address)}` : shortAddress(address);
  };
  // A stored account that is no longer in the list (archived since) stays
  // selectable as itself, so saving the form unchanged keeps it.
  const currentListed = current == null || options.some((o) => sameAddress(o.address, current));
  const sameAsSweep =
    value !== FEE_ACCOUNT_NONE && sweepDestination != null && sameAddress(value, sweepDestination);

  const kindLabel = (kind: FeeAccountOption["kind"]) =>
    kind === "minter" ? t("kindMain") : kind === "safe" ? t("kindSafe") : t("kindAccount");

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        save(() => updatePaymentSettingsAction({ feeAccount: value }));
      }}
    >
      <div className="space-y-1">
        <h3 className="text-sm font-medium">{t("title")}</h3>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="settings-feeAccount">{t("label")}</Label>
        <select
          id="settings-feeAccount"
          value={value}
          onChange={(e) => {
            clear();
            setValue(e.target.value);
          }}
          className={selectClass}
        >
          <option value={FEE_ACCOUNT_NONE}>{t("none")}</option>
          {options.map((o) => (
            <option key={o.address} value={o.address}>
              {`${o.name} (${kindLabel(o.kind)}) · ${shortAddress(o.address)}`}
            </option>
          ))}
          {!currentListed && current && (
            <option value={current}>{t("unlisted", { address: shortAddress(current) })}</option>
          )}
        </select>
        <p className="text-xs text-muted-foreground">{t("hint")}</p>
      </div>
      {sameAsSweep && (
        <Alert variant="warning">
          <AlertTriangle className="size-4" />
          <AlertDescription>{t("sameAsSweep")}</AlertDescription>
        </Alert>
      )}
      <SettingNotice
        field="feeAccountAddress"
        view={view}
        local={current}
        format={formatAccount}
      />
      <SaveRow pending={pending} result={result} />
    </form>
  );
}

// --- Payout fee (platform fee) ---------------------------------------------

export function PayoutFeeForm({
  bps,
  view,
}: {
  bps: number;
  view: PaymentSettingView;
}) {
  const t = useTranslations("fund.settings.fees.payoutFee");
  const [value, setValue] = useState(bpsToPercentInput(bps));
  const { pending, result, save, clear } = useSave((r) => {
    if ("ok" in r && r.revertedTo?.field === "platformPayoutFeeBps") {
      setValue(bpsToPercentInput(Number(r.revertedTo.value ?? 0)));
    }
  });
  const formatBps = (v: PaymentSettingValue) =>
    !v ? t("none") : `${bpsToPercentInput(Number(v))} %`;
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        save(() => updatePaymentSettingsAction({ platformPayoutFee: value }));
      }}
    >
      <div className="space-y-1">
        <h3 className="text-sm font-medium">{t("title")}</h3>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="settings-platformPayoutFee">{t("label")}</Label>
        <Input
          id="settings-platformPayoutFee"
          inputMode="decimal"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => {
            clear();
            setValue(e.target.value);
          }}
        />
        <p className="text-xs text-muted-foreground">{t("hint")}</p>
      </div>
      <SettingNotice field="platformPayoutFeeBps" view={view} local={bps} format={formatBps} />
      <SaveRow pending={pending} result={result} />
    </form>
  );
}

// --- Instant terminal confirmation limit -------------------------------------

export function EarlyPaidForm({
  cents,
  effectiveCents,
  defaultCents,
  view,
}: {
  // Stored: null = Citizen Pay's default, 0 = no limit, else cents.
  cents: number | null;
  // The limit in force as Citizen Pay reports it (undefined = not reported).
  effectiveCents: number | null | undefined;
  // Citizen Pay's default, for the "Default (€50)" label.
  defaultCents: number;
  view: PaymentSettingView;
}) {
  const t = useTranslations("fund.settings.terminals.earlyPaid");
  const format = useFormatter();
  const initial = earlyPaidFromCents(cents);
  const [mode, setMode] = useState<EarlyPaidMode>(initial.mode);
  const [amount, setAmount] = useState(initial.amount);
  const { pending, result, save, clear } = useSave((r) => {
    if ("ok" in r && r.revertedTo?.field === "earlyPaidMaxCents") {
      const back = earlyPaidFromCents(r.revertedTo.value as number | null);
      setMode(back.mode);
      setAmount(back.amount);
    }
  });
  const euro = (c: number) =>
    format.number(c / 100, { style: "currency", currency: "EUR" });
  const formatCap = (v: PaymentSettingValue) =>
    v === null ? t("default", { amount: euro(defaultCents) }) : v === 0 ? t("none") : euro(Number(v));

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        save(() => updatePaymentSettingsAction({ earlyPaid: { mode, amount } }));
      }}
    >
      <div className="space-y-1">
        <h3 className="text-sm font-medium">{t("title")}</h3>
        <p className="text-xs text-muted-foreground">{t("description")}</p>
        <p className="text-xs text-muted-foreground">{t("risk")}</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="settings-earlyPaidMode">{t("label")}</Label>
        <select
          id="settings-earlyPaidMode"
          value={mode}
          onChange={(e) => {
            clear();
            setMode(e.target.value as EarlyPaidMode);
          }}
          className={selectClass}
        >
          <option value="default">{t("default", { amount: euro(defaultCents) })}</option>
          <option value="custom">{t("custom")}</option>
          <option value="none">{t("none")}</option>
        </select>
      </div>
      {mode === "custom" && (
        <div className="space-y-1.5">
          <Label htmlFor="settings-earlyPaidAmount">{t("amount")}</Label>
          <Input
            id="settings-earlyPaidAmount"
            inputMode="decimal"
            autoComplete="off"
            spellCheck={false}
            value={amount}
            onChange={(e) => {
              clear();
              setAmount(e.target.value);
            }}
          />
          <p className="text-xs text-muted-foreground">{t("amountHint")}</p>
        </div>
      )}
      {effectiveCents != null && (
        <p className="text-xs text-muted-foreground">
          {effectiveCents === 0
            ? t("effectiveNone")
            : t("effective", { amount: euro(effectiveCents) })}
        </p>
      )}
      <SettingNotice field="earlyPaidMaxCents" view={view} local={cents} format={formatCap} />
      <SaveRow pending={pending} result={result} />
    </form>
  );
}
