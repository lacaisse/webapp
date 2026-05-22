// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { CreditCard, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import {
  searchUnattachedCardsAction,
  type UnattachedCardHit,
} from "@/services/card/admin-actions";

// Typeahead for the activate-member dialog. Lists unattached cards
// (memberId is null) in the current fund, filtered by serial number.
// Empty query surfaces the most-recently-imported cards so the operator
// has something to scroll if no serial is in hand. Selection commits the
// card's id; a chip replaces the input until cleared.

const DEBOUNCE_MS = 200;

export type UnattachedCardPickerLabels = {
  field: string;
  placeholder: string;
  hint: string;
  searching: string;
  empty: string;
  emptyInitial: string;
  noAccount: string;
  clear: string;
};

export function UnattachedCardPicker({
  id,
  labels,
  value,
  onChange,
  error,
}: {
  id: string;
  labels: UnattachedCardPickerLabels;
  value: string | null;
  onChange: (next: { id: string; serialNumber: string } | null) => void;
  error: string | null;
}) {
  const [selectedState, setSelected] = useState<UnattachedCardHit | null>(
    null,
  );
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<UnattachedCardHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqIdRef = useRef(0);

  // Derived: if the parent dropped the value (form reset, external
  // clear), we drop the chip. Cheaper than a setState-in-effect sync,
  // and avoids the cascading-render lint.
  const selected = value === null ? null : selectedState;

  // Close on outside click.
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
        const results = await searchUnattachedCardsAction(term);
        if (reqId !== reqIdRef.current) return;
        setHits(results);
      } catch (e) {
        if (reqId !== reqIdRef.current) return;
        console.warn("[card-picker] search failed", e);
        setHits([]);
      } finally {
        if (reqId === reqIdRef.current) setLoading(false);
      }
    }, DEBOUNCE_MS);
  }

  function commit(card: UnattachedCardHit) {
    setSelected(card);
    setQuery("");
    setHits([]);
    setOpen(false);
    onChange({ id: card.id, serialNumber: card.serialNumber });
  }

  function clear() {
    setSelected(null);
    setQuery("");
    setHits([]);
    onChange(null);
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
      ? labels.empty
      : labels.emptyInitial
    : null;

  return (
    <div className="space-y-2" ref={containerRef}>
      <Label htmlFor={id}>{labels.field}</Label>
      {selected ? (
        <SelectedChip
          card={selected}
          onClear={clear}
          clearLabel={labels.clear}
        />
      ) : (
        <div className="relative">
          <Input
            id={id}
            autoComplete="off"
            spellCheck={false}
            placeholder={labels.placeholder}
            value={query}
            onChange={(e) => handleChange(e.target.value)}
            onFocus={handleFocus}
            onKeyDown={handleKeyDown}
            className="font-mono text-sm"
            aria-invalid={error ? true : undefined}
          />
          {open && (
            <Dropdown
              hits={hits}
              activeIndex={activeIndex}
              loading={loading}
              emptyText={emptyText}
              labels={labels}
              onPick={commit}
              onHover={setActiveIndex}
            />
          )}
        </div>
      )}
      {!selected && (
        <p className="text-xs text-muted-foreground">{labels.hint}</p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

function SelectedChip({
  card,
  onClear,
  clearLabel,
}: {
  card: UnattachedCardHit;
  onClear: () => void;
  clearLabel: string;
}) {
  // One-line chip: matches the input's height so the dialog doesn't
  // re-flow when a card is picked. Account is shown muted on the same row
  // so the operator can still verify identity without doubling height.
  return (
    <div className="flex items-center gap-2 rounded-lg border border-input bg-muted/30 px-2.5 py-1.5">
      <CreditCard className="size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="shrink-0 font-mono text-sm font-medium">
          {card.serialNumber}
        </span>
        {card.account && (
          <span className="truncate font-mono text-xs text-muted-foreground">
            {card.account}
          </span>
        )}
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

function Dropdown({
  hits,
  activeIndex,
  loading,
  emptyText,
  labels,
  onPick,
  onHover,
}: {
  hits: UnattachedCardHit[];
  activeIndex: number;
  loading: boolean;
  emptyText: string | null;
  labels: UnattachedCardPickerLabels;
  onPick: (card: UnattachedCardHit) => void;
  onHover: (i: number) => void;
}) {
  return (
    <div
      role="listbox"
      className="absolute top-full right-0 left-0 z-50 mt-1 max-h-72 overflow-auto rounded-lg border border-border bg-popover shadow-lg"
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
      {hits.map((card, i) => (
        <button
          key={card.id}
          type="button"
          role="option"
          aria-selected={i === activeIndex}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(card);
          }}
          onMouseEnter={() => onHover(i)}
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
            <div className="truncate font-mono text-xs text-muted-foreground">
              {card.account ?? labels.noAccount}
            </div>
          </div>
        </button>
      ))}
    </div>
  );
}
