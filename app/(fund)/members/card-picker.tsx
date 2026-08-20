// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { CreditCard, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  searchCardsForAssignmentAction,
  type AssignableCardHit,
} from "@/services/card/admin-actions";

// Card picker for the activate-member dialog (#190 follow-up). The field is a
// button that opens a full-height modal: search on top, the fund's card
// inventory below — assignable cards first in card-number order, then the
// unavailable ones (already assigned / blocked / reported lost) rendered
// disabled with the reason. Showing the unavailable rows is deliberate: the
// operator searching for a specific card learns WHY it can't be picked instead
// of wondering where it went. Selection commits the card's id; a chip replaces
// the trigger until cleared.

const DEBOUNCE_MS = 200;

export type CardPickerLabels = {
  field: string;
  choose: string;
  modalTitle: string;
  modalDescription: string;
  placeholder: string;
  hint: string;
  searching: string;
  empty: string;
  emptyInitial: string;
  available: string;
  unavailable: string;
  assignedTo: (name: string) => string;
  blocked: string;
  lost: string;
  noNumber: string;
  clear: string;
};

export function CardPicker({
  id,
  labels,
  value,
  onChange,
  error,
}: {
  id: string;
  labels: CardPickerLabels;
  value: string | null;
  onChange: (next: { id: string; serialNumber: string } | null) => void;
  error: string | null;
}) {
  const [selectedState, setSelected] = useState<AssignableCardHit | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<AssignableCardHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqIdRef = useRef(0);

  // Derived: if the parent dropped the value (form reset, external clear), we
  // drop the chip. Cheaper than a setState-in-effect sync, and avoids the
  // cascading-render lint.
  const selected = value === null ? null : selectedState;

  function runSearch(term: string, immediate = false) {
    setLoading(true);
    const reqId = ++reqIdRef.current;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(
      async () => {
        try {
          const results = await searchCardsForAssignmentAction(term);
          if (reqId !== reqIdRef.current) return;
          setHits(results);
        } catch (e) {
          if (reqId !== reqIdRef.current) return;
          console.warn("[card-picker] search failed", e);
          setHits([]);
        } finally {
          if (reqId === reqIdRef.current) setLoading(false);
        }
      },
      immediate ? 0 : DEBOUNCE_MS,
    );
  }

  // Opening resets the search and loads the full inventory immediately so the
  // operator can scroll without typing first. Done in the click handler (not
  // an on-open effect) to keep setState out of effects.
  function openPicker() {
    setQuery("");
    setHits([]);
    setActiveIndex(0);
    setOpen(true);
    runSearch("", true);
  }

  function handleQueryChange(next: string) {
    setQuery(next);
    setActiveIndex(0);
    runSearch(next.trim());
  }

  function commit(card: AssignableCardHit) {
    setSelected(card);
    setOpen(false);
    onChange({ id: card.id, serialNumber: card.serialNumber });
  }

  function clear() {
    setSelected(null);
    onChange(null);
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{labels.field}</Label>
      {selected ? (
        <SelectedChip
          card={selected}
          onClear={clear}
          clearLabel={labels.clear}
        />
      ) : (
        <Button
          id={id}
          type="button"
          variant="outline"
          onClick={openPicker}
          aria-invalid={error ? true : undefined}
          className="w-full justify-start gap-2 font-normal text-muted-foreground"
        >
          <Search className="size-4 shrink-0" />
          {labels.choose}
        </Button>
      )}
      {!selected && (
        <p className="text-xs text-muted-foreground">{labels.hint}</p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
      <CardPickerDialog
        open={open}
        onOpenChange={setOpen}
        labels={labels}
        query={query}
        hits={hits}
        loading={loading}
        activeIndex={activeIndex}
        onQueryChange={handleQueryChange}
        onActiveIndexChange={setActiveIndex}
        onPick={commit}
      />
    </div>
  );
}

function CardPickerDialog({
  open,
  onOpenChange,
  labels,
  query,
  hits,
  loading,
  activeIndex,
  onQueryChange,
  onActiveIndexChange,
  onPick,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  labels: CardPickerLabels;
  query: string;
  hits: AssignableCardHit[];
  loading: boolean;
  activeIndex: number;
  onQueryChange: (next: string) => void;
  onActiveIndexChange: (i: number) => void;
  onPick: (card: AssignableCardHit) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  const assignable = hits.filter((h) => h.assignable);
  const unavailable = hits.filter((h) => !h.assignable);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (assignable.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      onActiveIndexChange(Math.min(activeIndex + 1, assignable.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      onActiveIndexChange(Math.max(activeIndex - 1, 0));
    } else if (e.key === "Enter") {
      const row = assignable[activeIndex];
      if (row) {
        e.preventDefault();
        onPick(row);
      }
    }
  }

  // Keep the keyboard-active row visible while arrowing through the list.
  useEffect(() => {
    listRef.current
      ?.querySelector('[data-active="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const term = query.trim();
  const empty = !loading && hits.length === 0;
  const emptyText = empty
    ? term.length > 0
      ? labels.empty
      : labels.emptyInitial
    : null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[min(36rem,85dvh)] flex-col gap-3">
        <DialogHeader>
          <DialogTitle>{labels.modalTitle}</DialogTitle>
          <DialogDescription>{labels.modalDescription}</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            autoComplete="off"
            spellCheck={false}
            placeholder={labels.placeholder}
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={handleKeyDown}
            className="pl-8 font-mono text-sm"
          />
        </div>
        <div
          ref={listRef}
          role="listbox"
          className="min-h-40 flex-1 overflow-y-auto rounded-lg border border-border"
        >
          {loading && (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              {labels.searching}
            </div>
          )}
          {!loading && emptyText && (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              {emptyText}
            </div>
          )}
          {!loading && assignable.length > 0 && (
            <SectionHeader>{labels.available}</SectionHeader>
          )}
          {!loading &&
            assignable.map((card, i) => (
              <button
                key={card.id}
                type="button"
                role="option"
                aria-selected={i === activeIndex}
                data-active={i === activeIndex}
                onMouseDown={(e) => {
                  e.preventDefault();
                  onPick(card);
                }}
                onMouseEnter={() => onActiveIndexChange(i)}
                className={cn(
                  "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors",
                  i === activeIndex ? "bg-muted" : "hover:bg-muted/60",
                )}
              >
                <CardIdentity card={card} noNumberLabel={labels.noNumber} />
              </button>
            ))}
          {!loading && unavailable.length > 0 && (
            <SectionHeader>{labels.unavailable}</SectionHeader>
          )}
          {!loading &&
            unavailable.map((card) => (
              <div
                key={card.id}
                aria-disabled
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm opacity-55"
              >
                <CardIdentity card={card} noNumberLabel={labels.noNumber} />
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                  {card.assignedTo
                    ? labels.assignedTo(card.assignedTo)
                    : card.reportedLost
                      ? labels.lost
                      : labels.blocked}
                </span>
              </div>
            ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="sticky top-0 border-b border-border bg-background/95 px-3 py-1 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
      {children}
    </div>
  );
}

function CardIdentity({
  card,
  noNumberLabel,
}: {
  card: AssignableCardHit;
  noNumberLabel: string;
}) {
  return (
    <>
      <CreditCard className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-sm font-medium">
          {card.number != null ? `#${card.number}` : noNumberLabel}
          <span className="ml-2 font-normal text-muted-foreground">
            {card.serialNumber}
          </span>
        </div>
        {card.account && (
          <div className="truncate font-mono text-xs text-muted-foreground">
            {card.account}
          </div>
        )}
      </div>
    </>
  );
}

function SelectedChip({
  card,
  onClear,
  clearLabel,
}: {
  card: AssignableCardHit;
  onClear: () => void;
  clearLabel: string;
}) {
  // One-line chip: matches the trigger's height so the dialog doesn't re-flow
  // when a card is picked. The card number is shown alongside so the operator
  // can verify identity without doubling height.
  return (
    <div className="flex items-center gap-2 rounded-lg border border-input bg-muted/30 px-2.5 py-1.5">
      <CreditCard className="size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        {card.number != null && (
          <span className="shrink-0 font-mono text-sm font-medium">
            #{card.number}
          </span>
        )}
        <span className="truncate font-mono text-xs text-muted-foreground">
          {card.serialNumber}
        </span>
      </div>
      <button
        type="button"
        onClick={onClear}
        className="rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        aria-label={clearLabel}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
