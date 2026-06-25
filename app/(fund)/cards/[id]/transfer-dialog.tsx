// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { CreditCard, X } from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";
import { useTranslations } from "next-intl";

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
  searchTransferTargetCardsAction,
  transferBetweenCardsAction,
  type TransferTargetHit,
} from "@/services/card/admin-actions";

// Move a balance from this card to another card in the fund (e.g. carry a lost
// card's remaining funds onto its replacement). Available whenever the source
// card has a CP account + the fund's token is configured — independent of the
// card's status, since draining a blocked/lost card is exactly the point.

const DEBOUNCE_MS = 200;

export function TransferDialog({
  cardId,
  holderLabel,
  tokenSymbol,
}: {
  cardId: string;
  holderLabel: string;
  tokenSymbol: string | null;
}) {
  const t = useTranslations("cards.admin.transfer");
  const tRoot = useTranslations();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<TransferTargetHit | null>(null);
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onOpenChange(next: boolean) {
    if (!next && pending) return;
    setOpen(next);
    if (!next) {
      setTarget(null);
      setAmount("");
      setError(null);
      setSuccess(null);
    }
  }

  const onSubmit = () => {
    setError(null);
    if (!target) {
      setError(t("targetRequired"));
      return;
    }
    startTransition(async () => {
      const result = await transferBetweenCardsAction({
        fromCardId: cardId,
        toCardId: target.id,
        amount,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setSuccess(result.txHash);
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger render={<Button variant="outline" size="sm" />}>
        {t("button")}
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {t("description", { holderLabel })}
          </DialogDescription>
        </DialogHeader>
        {success ? (
          <Alert>
            <AlertDescription>
              <div>{t("success")}</div>
              <div className="mt-1 font-mono text-xs break-all">{success}</div>
            </AlertDescription>
          </Alert>
        ) : (
          <div className="min-w-0 space-y-3">
            <TargetCardPicker
              id={`transfer-target-${cardId}`}
              excludeCardId={cardId}
              value={target}
              onChange={setTarget}
            />
            <div className="space-y-2">
              <Label htmlFor={`transfer-amount-${cardId}`}>
                {t("amountLabel")}
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id={`transfer-amount-${cardId}`}
                  autoComplete="off"
                  inputMode="decimal"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
                {tokenSymbol && (
                  <span className="text-sm text-muted-foreground whitespace-nowrap">
                    {tokenSymbol}
                  </span>
                )}
              </div>
            </div>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
          </div>
        )}
        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            {success ? tRoot("common.close") : tRoot("common.cancel")}
          </Button>
          {!success && (
            <Button onClick={onSubmit} disabled={pending}>
              {pending ? t("submitting") : t("confirm")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Inline typeahead over fund cards that can receive the transfer. Mirrors the
// unattached-card picker's mechanics (debounced search, keyboard nav, chip on
// select) but searches all accounted cards except the source.
function TargetCardPicker({
  id,
  excludeCardId,
  value,
  onChange,
}: {
  id: string;
  excludeCardId: string;
  value: TransferTargetHit | null;
  onChange: (next: TransferTargetHit | null) => void;
}) {
  const t = useTranslations("cards.admin.transfer.target");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<TransferTargetHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqIdRef = useRef(0);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  function runSearch(term: string) {
    setLoading(true);
    const reqId = ++reqIdRef.current;
    debounceRef.current = setTimeout(async () => {
      try {
        const results = await searchTransferTargetCardsAction({
          excludeCardId,
          q: term,
        });
        if (reqId !== reqIdRef.current) return;
        setHits(results);
      } catch (e) {
        if (reqId !== reqIdRef.current) return;
        console.warn("[transfer-picker] search failed", e);
        setHits([]);
      } finally {
        if (reqId === reqIdRef.current) setLoading(false);
      }
    }, DEBOUNCE_MS);
  }

  function commit(card: TransferTargetHit) {
    setQuery("");
    setHits([]);
    setOpen(false);
    onChange(card);
  }

  function handleChange(next: string) {
    setQuery(next);
    setOpen(true);
    setActiveIndex(0);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    runSearch(next.trim());
  }

  function handleFocus() {
    setOpen(true);
    if (hits.length === 0 && !loading) {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      runSearch(query.trim());
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || hits.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, hits.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      const row = hits[activeIndex];
      if (row) {
        e.preventDefault();
        commit(row);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  const term = query.trim();
  const empty = !loading && hits.length === 0;
  const emptyText = empty
    ? term.length > 0
      ? t("empty")
      : t("emptyInitial")
    : null;

  return (
    <div className="space-y-2" ref={containerRef}>
      <Label htmlFor={id}>{t("field")}</Label>
      {value ? (
        <div className="flex items-center gap-2 rounded-lg border border-input bg-muted/30 px-2.5 py-1.5">
          <CreditCard className="size-4 shrink-0 text-muted-foreground" />
          <div className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="shrink-0 font-mono text-sm font-medium">
              {value.serialNumber}
            </span>
            {value.holderName && (
              <span className="truncate text-xs text-muted-foreground">
                {value.holderName}
              </span>
            )}
          </div>
          <button
            type="button"
            onClick={() => onChange(null)}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-label={t("clear")}
          >
            <X className="size-3.5" />
          </button>
        </div>
      ) : (
        <div className="relative">
          <Input
            id={id}
            autoComplete="off"
            spellCheck={false}
            placeholder={t("placeholder")}
            value={query}
            onChange={(e) => handleChange(e.target.value)}
            onFocus={handleFocus}
            onKeyDown={handleKeyDown}
            className="text-sm"
          />
          {open && (
            <div
              role="listbox"
              className="absolute top-full right-0 left-0 z-50 mt-1 max-h-72 overflow-auto rounded-lg border border-border bg-popover shadow-lg"
            >
              {loading && (
                <div className="px-3 py-2 text-xs text-muted-foreground">
                  {t("searching")}
                </div>
              )}
              {!loading && emptyText && (
                <div className="px-3 py-2 text-xs text-muted-foreground">
                  {emptyText}
                </div>
              )}
              {hits.map((card, i) => (
                <button
                  key={card.id}
                  type="button"
                  role="option"
                  aria-selected={i === activeIndex}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    commit(card);
                  }}
                  onMouseEnter={() => setActiveIndex(i)}
                  className={cn(
                    "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors",
                    i === activeIndex ? "bg-muted" : "hover:bg-muted/60",
                  )}
                >
                  <CreditCard className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-sm font-medium">
                      {card.serialNumber}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">
                      {card.holderName ??
                        (card.number != null ? `#${card.number}` : t("noName"))}
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <p className="text-xs text-muted-foreground">{t("hint")}</p>
    </div>
  );
}
