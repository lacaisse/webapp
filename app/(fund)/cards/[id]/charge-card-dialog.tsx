// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { Loader2 } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useEffect, useState, useTransition } from "react";

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
import { cn } from "@/lib/utils";
import {
  chargeCardAction,
  listOpenMerchantOrdersAction,
  type ChargeableMerchant,
  type ChargeCardOutcome,
} from "@/services/card/charge-actions";
import {
  newChargeIdempotencyKey,
  parseAmountCents,
} from "@/services/card/charge-errors";
import { hashCardPin } from "@/services/card/pin-hash";
import type { OpenPlaceOrder } from "@/services/citizenpay/types";

// Charge this card for a sale at one of the fund's merchants that the
// merchant's pay-pos failed to collect — the card could not be read, the PIN
// was wrong, the terminal lost its network. Pick the merchant; its
// uncollected sales are offered first (the amount is the order's), or type
// an amount and description when the terminal never recorded one (Citizen
// Pay then creates the order on the merchant's place as the terminal would
// have). Either way the sale lands in the merchant's sales and payouts.
//
// The PIN step follows the pay-pos: the charge is sent without a PIN; when
// Citizen Pay asks for it (428) the dialog takes it from the cardholder,
// hashes it here (the raw PIN never leaves this page) and resends the same
// request. Charging twice is ruled out on both sides: Citizen Pay claims the
// order before any money moves, and a manual charge carries an idempotency
// key minted when the dialog opened and kept across its retries. When Citizen
// Pay says the outcome is unknown (the transfer may have been sent; it is
// confirming it) the dialog stops: no retry, the order must not be charged
// again.

type Step = "form" | "pin" | "done" | "unknown";

type Done = {
  orderId: number;
  txHash: string;
  settled: boolean;
  existing: boolean;
};

export function ChargeCardDialog({
  cardId,
  serialNumber,
  holderLabel,
  tokenSymbol,
  merchants,
}: {
  cardId: string;
  /** The exact serial the charge sends: the salt of the PIN digest. */
  serialNumber: string;
  holderLabel: string;
  tokenSymbol: string | null;
  /** The fund's active merchants connected to Citizen Pay. */
  merchants: ChargeableMerchant[];
}) {
  const t = useTranslations("cards.admin.charge");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  function onOpenChange(next: boolean) {
    if (!next && busy) return;
    setOpen(next);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger
        render={<Button variant="outline" size="sm" />}
        disabled={merchants.length === 0}
      >
        {t("button")}
      </DialogTrigger>
      {/* The form lives only while the dialog is open: closing it unmounts
          the state, so every opening starts blank with a fresh key. */}
      {open && (
        <ChargeCardForm
          cardId={cardId}
          serialNumber={serialNumber}
          holderLabel={holderLabel}
          tokenSymbol={tokenSymbol}
          merchants={merchants}
          onBusy={setBusy}
          onClose={() => setOpen(false)}
        />
      )}
    </Dialog>
  );
}

function ChargeCardForm({
  cardId,
  serialNumber,
  holderLabel,
  tokenSymbol,
  merchants,
  onBusy,
  onClose,
}: {
  cardId: string;
  serialNumber: string;
  holderLabel: string;
  tokenSymbol: string | null;
  merchants: ChargeableMerchant[];
  onBusy: (busy: boolean) => void;
  onClose: () => void;
}) {
  const t = useTranslations("cards.admin.charge");
  const tRoot = useTranslations();
  const format = useFormatter();

  const [step, setStep] = useState<Step>("form");
  const [merchantId, setMerchantId] = useState(
    merchants.length === 1 ? merchants[0].id : "",
  );
  // The merchant's uncollected sales: null while loading, [] when none.
  const [openOrders, setOpenOrders] = useState<OpenPlaceOrder[] | null>(null);
  const [ordersError, setOrdersError] = useState<string | null>(null);
  // "" = a new sale typed below; otherwise the id of the order to pay.
  const [orderChoice, setOrderChoice] = useState("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [pin, setPin] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  // The order a manual charge created before the card refused: every later
  // attempt in this dialog charges it instead of creating another.
  const [createdOrderId, setCreatedOrderId] = useState<number | null>(null);
  // The amount that order carries, frozen when it was created so the form
  // cannot drift from what the order says.
  const [lockedCents, setLockedCents] = useState<number | null>(null);
  // Minted once per opened dialog, sent with every manual attempt.
  const [idempotencyKey] = useState(newChargeIdempotencyKey);
  const [unknownOrderId, setUnknownOrderId] = useState<number | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    onBusy(pending);
  }, [pending, onBusy]);

  function selectMerchant(id: string) {
    setMerchantId(id);
    setOpenOrders(null);
    setOrdersError(null);
    setOrderChoice("");
  }

  // Load the merchant's open sales whenever the merchant changes (the state
  // was reset by selectMerchant; the initial single merchant starts blank).
  useEffect(() => {
    if (!merchantId) return;
    let cancelled = false;
    listOpenMerchantOrdersAction({ merchantId }).then((res) => {
      if (cancelled) return;
      if ("error" in res) {
        setOrdersError(res.error);
        setOpenOrders([]);
        return;
      }
      setOpenOrders(res.orders);
      // One open sale is almost always the one to collect; preselect it.
      if (res.orders.length === 1) setOrderChoice(String(res.orders[0].id));
    });
    return () => {
      cancelled = true;
    };
  }, [merchantId]);

  const merchant = merchants.find((m) => m.id === merchantId) ?? null;
  const chosenOrder =
    openOrders?.find((o) => String(o.id) === orderChoice) ?? null;
  // What this attempt charges: an existing order (picked, or created by an
  // earlier attempt) or a new sale for `amount`.
  const orderId = chosenOrder?.id ?? createdOrderId;
  const cents =
    chosenOrder?.totalCents ??
    (createdOrderId !== null ? lockedCents : parseAmountCents(amount));

  const money = (c: number) =>
    `${format.number(c / 100, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}${tokenSymbol ? ` ${tokenSymbol}` : ""}`;

  function charge(pinHash: string | null) {
    if (!merchant) {
      setError(t("merchantRequired"));
      return;
    }
    if (orderId === null && cents === null) {
      setError(t("errors.amountInvalid"));
      return;
    }
    setError(null);
    startTransition(async () => {
      const outcome = await chargeCardAction({
        cardId,
        merchantId: merchant.id,
        orderId,
        amountCents: orderId === null ? cents : null,
        description: orderId === null ? description.trim() || null : null,
        pinHash,
        idempotencyKey,
      });
      handleOutcome(outcome);
    });
  }

  function handleOutcome(outcome: ChargeCardOutcome) {
    if (outcome.ok) {
      setDone({
        orderId: outcome.orderId,
        txHash: outcome.txHash,
        settled: outcome.settled,
        existing: outcome.existing,
      });
      setStep("done");
      return;
    }
    if (outcome.pinRequired) {
      setPin("");
      setStep("pin");
      return;
    }
    // A wrong PIN is asked again, whatever else this dialog knows (an order
    // it created included): the next attempt would only get another 428.
    if (outcome.error === tRoot("cards.admin.charge.errors.pinInvalid")) {
      setPin("");
      setStep("pin");
      setError(outcome.error);
      return;
    }
    // Citizen Pay may have sent the transfer and is confirming it: the
    // order must not be charged again, by this dialog or another. Final.
    if (outcome.orderStatus === "confirming") {
      setUnknownOrderId(outcome.orderId);
      setStep("unknown");
      return;
    }
    // The manual route created the order and the card then refused: keep
    // the order, the next attempt charges it.
    if (outcome.orderId !== null && orderId === null) {
      setCreatedOrderId(outcome.orderId);
      setLockedCents(cents);
      setStep("form");
      setError(
        `${outcome.error} ${t("failedWithOrder", { id: outcome.orderId })}`,
      );
      return;
    }
    setStep("form");
    setError(outcome.error);
  }

  function submitForm() {
    if (orderId === null && cents === null) {
      setError(t("errors.amountInvalid"));
      return;
    }
    charge(null);
  }

  function submitPin() {
    const value = pin.trim();
    if (value === "") {
      setError(t("pin.required"));
      return;
    }
    // Salted with the exact serial the charge sends.
    charge(hashCardPin(serialNumber, value));
  }

  function close() {
    if (pending) return;
    onClose();
  }

  const inputId = (name: string) => `charge-${name}-${cardId}`;

  return (
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{t("title")}</DialogTitle>
        <DialogDescription>
          {step === "pin"
            ? t("pin.description")
            : t("description", { holderLabel })}
        </DialogDescription>
      </DialogHeader>

      {step === "form" && (
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            submitForm();
          }}
        >
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor={inputId("merchant")}>{t("merchantLabel")}</Label>
              <select
                id={inputId("merchant")}
                value={merchantId}
                onChange={(e) => selectMerchant(e.target.value)}
                disabled={pending || createdOrderId !== null}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">{t("merchantPlaceholder")}</option>
                {merchants.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>

            {merchant && createdOrderId === null && (
              <div className="space-y-2">
                <Label>{t("saleLabel")}</Label>
                {openOrders === null ? (
                  <p className="text-xs text-muted-foreground">
                    {t("ordersLoading")}
                  </p>
                ) : (
                  <div className="space-y-2">
                    {ordersError && (
                      <p className="text-xs text-destructive">{ordersError}</p>
                    )}
                    {openOrders.map((o) => (
                      <OrderOption
                        key={o.id}
                        name={inputId("sale")}
                        value={String(o.id)}
                        checked={orderChoice === String(o.id)}
                        onChange={() => setOrderChoice(String(o.id))}
                        title={money(o.totalCents)}
                        detail={[
                          format.dateTime(new Date(o.createdAt), {
                            dateStyle: "medium",
                            timeStyle: "short",
                          }),
                          o.terminalName,
                          o.description,
                          t(`status.${o.status}` as never),
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      />
                    ))}
                    <OrderOption
                      name={inputId("sale")}
                      value=""
                      checked={orderChoice === ""}
                      onChange={() => setOrderChoice("")}
                      title={t("newSale")}
                      detail={
                        openOrders.length === 0
                          ? t("noOpenOrders")
                          : t("newSaleHint")
                      }
                    />
                  </div>
                )}
              </div>
            )}

            {merchant && createdOrderId !== null && (
              <p className="text-xs text-muted-foreground">
                {t("createdOrder", { id: createdOrderId })}
                {lockedCents !== null && ` · ${money(lockedCents)}`}
              </p>
            )}

            {merchant && orderId === null && openOrders !== null && (
              <>
                <div className="space-y-2">
                  <Label htmlFor={inputId("amount")}>{t("amountLabel")}</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id={inputId("amount")}
                      autoComplete="off"
                      inputMode="decimal"
                      placeholder="0.00"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                    />
                    {tokenSymbol && (
                      <span className="text-sm whitespace-nowrap text-muted-foreground">
                        {tokenSymbol}
                      </span>
                    )}
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor={inputId("description")}>
                    {t("descriptionLabel")}
                  </Label>
                  <Input
                    id={inputId("description")}
                    autoComplete="off"
                    maxLength={200}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder={t("descriptionPlaceholder")}
                  />
                </div>
              </>
            )}

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
              onClick={close}
              disabled={pending}
            >
              {tRoot("common.cancel")}
            </Button>
            <Button
              type="submit"
              disabled={
                pending || !merchant || (orderId === null && cents === null)
              }
            >
              {pending && <Loader2 className="size-3.5 animate-spin" />}
              {cents !== null
                ? t("confirmAmount", { amount: money(cents) })
                : t("confirm")}
            </Button>
          </DialogFooter>
        </form>
      )}

      {step === "pin" && (
        <form
          className="contents"
          onSubmit={(e) => {
            e.preventDefault();
            submitPin();
          }}
        >
          <div className="space-y-4">
            <p className="text-xs text-muted-foreground">
              {merchant?.name}
              {cents !== null && ` · ${money(cents)}`}
            </p>
            <div className="space-y-2">
              <Label htmlFor={inputId("pin")}>{t("pin.label")}</Label>
              <Input
                id={inputId("pin")}
                type="password"
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                value={pin}
                onChange={(e) => setPin(e.target.value)}
                className="font-mono tracking-[0.3em]"
              />
              <p className="text-xs text-muted-foreground">{t("pin.hint")}</p>
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
              onClick={() => {
                if (pending) return;
                setPin("");
                setError(null);
                setStep("form");
              }}
              disabled={pending}
            >
              {tRoot("common.back")}
            </Button>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2 className="size-3.5 animate-spin" />}
              {t("pin.confirm")}
            </Button>
          </DialogFooter>
        </form>
      )}

      {step === "unknown" && (
        <>
          <Alert variant="destructive">
            <AlertDescription>
              <div>
                {unknownOrderId !== null
                  ? t("unknown.body", { id: unknownOrderId })
                  : t("unknown.noOrder")}
              </div>
              <div className="mt-1 text-xs">{t("unknown.next")}</div>
            </AlertDescription>
          </Alert>
          <DialogFooter>
            <Button type="button" onClick={close}>
              {tRoot("common.close")}
            </Button>
          </DialogFooter>
        </>
      )}

      {step === "done" && done && (
        <>
          <Alert>
            <AlertDescription>
              <div>
                {done.settled
                  ? t("done.body", { id: done.orderId })
                  : t("done.unsettled", { id: done.orderId })}
              </div>
              {done.existing && (
                <div className="mt-1 text-xs">{t("done.existing")}</div>
              )}
              <div className="mt-1 font-mono text-xs break-all">
                {done.txHash}
              </div>
            </AlertDescription>
          </Alert>
          <DialogFooter>
            <Button type="button" onClick={close}>
              {tRoot("common.close")}
            </Button>
          </DialogFooter>
        </>
      )}
    </DialogContent>
  );
}

function OrderOption({
  name,
  value,
  checked,
  onChange,
  title,
  detail,
}: {
  name: string;
  value: string;
  checked: boolean;
  onChange: () => void;
  title: string;
  detail: string;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-3 rounded-md border border-border bg-card p-3 transition-colors hover:bg-muted/40",
        checked && "border-primary",
      )}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={onChange}
        className="mt-1 size-4 border-input"
      />
      <div className="flex-1 space-y-0.5">
        <div className="text-sm font-medium tabular-nums">{title}</div>
        <div className="text-xs text-muted-foreground">{detail}</div>
      </div>
    </label>
  );
}
