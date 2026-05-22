// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { Store, User, Wallet, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { shortAddress } from "@/services/alchemy/format";
import {
  searchTokenRecipientsAction,
  type RecipientHit,
} from "@/services/token-operations/search-actions";

// Address-or-entity picker used by the /token mint and burn dialogs.
//
// Two modes:
//   1) Search — input is free text; we typeahead against cards (serial /
//      holder / member name) and merchants (place name) and render a
//      dropdown. Pasting a 0x address adds a synthetic "external wallet"
//      row so the operator can opt into minting/burning to an unknown
//      address.
//   2) Selected — a chip replaces the input showing what was picked
//      (card holder, place name, or "External wallet"). Clearing the chip
//      returns to search mode.
//
// The form sees only the resolved address via `onChange`. The chip exists
// so the operator can verify they didn't fat-finger a serial → wrong card.

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const DEBOUNCE_MS = 200;

export type RecipientPickerLabels = {
  field: string;
  placeholder: string;
  searchHint: string;
  emptyHint: string;
  searching: string;
  external: string;
  externalWarning: string;
  card: string;
  place: string;
  clear: string;
};

type Selected = {
  account: string;
  label: string;
  kind: RecipientHit["kind"] | "external";
};

type Row =
  | { kind: "hit"; hit: RecipientHit }
  | { kind: "external"; account: string };

export function RecipientPicker({
  id,
  labels,
  value,
  onChange,
  error,
}: {
  id: string;
  labels: RecipientPickerLabels;
  value: string;
  onChange: (next: string) => void;
  error: string | null;
}) {
  const [selectedState, setSelected] = useState<Selected | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<RecipientHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reqIdRef = useRef(0);

  // Derived: if the parent zeroed out the value (form.reset on dialog
  // close, or an external clear) we drop the chip — even if our local
  // `selectedState` hasn't caught up yet. Cheaper than a setState-in-
  // effect sync, and avoids the cascading-render lint.
  const selected = value === "" ? null : selectedState;

  // Close on outside click. Keeps the dropdown from lingering when the
  // operator clicks the amount field next to it.
  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!containerRef.current) return;
      if (!containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  function commit(next: Selected) {
    setSelected(next);
    setQuery("");
    setHits([]);
    setOpen(false);
    onChange(next.account);
  }

  function clear() {
    setSelected(null);
    setQuery("");
    setHits([]);
    onChange("");
  }

  function handleChange(next: string) {
    setQuery(next);
    setOpen(true);
    setActiveIndex(0);

    // Mirror the typed value into the form so submitting without picking
    // from the dropdown (pasting an address and pressing Enter) still
    // works.
    onChange(next.trim());

    if (debounceRef.current) clearTimeout(debounceRef.current);
    const term = next.trim();
    if (term.length < 2 || ADDRESS_RE.test(term)) {
      // No need to search for an exact-address input — the synthetic
      // "external" row handles it. Below 2 chars: not enough signal.
      setHits([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const reqId = ++reqIdRef.current;
    debounceRef.current = setTimeout(async () => {
      try {
        const results = await searchTokenRecipientsAction(term);
        if (reqId !== reqIdRef.current) return;
        setHits(results);
      } catch (e) {
        if (reqId !== reqIdRef.current) return;
        console.warn("[recipient-picker] search failed", e);
        setHits([]);
      } finally {
        if (reqId === reqIdRef.current) setLoading(false);
      }
    }, DEBOUNCE_MS);
  }

  const term = query.trim();
  const looksLikeAddress = ADDRESS_RE.test(term);
  const rows: Row[] = [];
  for (const h of hits) rows.push({ kind: "hit", hit: h });
  if (looksLikeAddress) {
    // Don't double-list if the pasted address matches a labelled card/place.
    const dup = hits.some(
      (h) => h.account.toLowerCase() === term.toLowerCase(),
    );
    if (!dup) rows.push({ kind: "external", account: term });
  }

  function commitRow(row: Row) {
    if (row.kind === "hit") {
      commit({
        account: row.hit.account,
        label: row.hit.label,
        kind: row.hit.kind,
      });
    } else {
      commit({
        account: row.account,
        label: labels.external,
        kind: "external",
      });
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (!open || rows.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, rows.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      const row = rows[activeIndex];
      if (row) {
        e.preventDefault();
        commitRow(row);
      }
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  const hint = term.length === 0 ? labels.searchHint : null;
  const empty =
    !loading && rows.length === 0 && term.length >= 2 && !looksLikeAddress
      ? labels.emptyHint
      : null;

  return (
    <div className="space-y-2" ref={containerRef}>
      <Label htmlFor={id}>{labels.field}</Label>
      {selected ? (
        <SelectedChip
          selected={selected}
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
            onFocus={() => setOpen(true)}
            onKeyDown={handleKeyDown}
            className={cn(looksLikeAddress && "font-mono text-sm")}
            aria-invalid={error ? true : undefined}
          />
          {open && (rows.length > 0 || loading || hint || empty) && (
            <Dropdown
              rows={rows}
              activeIndex={activeIndex}
              loading={loading}
              hint={hint ?? empty}
              labels={labels}
              onPick={commitRow}
              onHover={setActiveIndex}
            />
          )}
        </div>
      )}
      {selected?.kind === "external" && (
        <p className="text-xs text-warning">{labels.externalWarning}</p>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

function SelectedChip({
  selected,
  onClear,
  clearLabel,
}: {
  selected: Selected;
  onClear: () => void;
  clearLabel: string;
}) {
  const Icon =
    selected.kind === "card"
      ? User
      : selected.kind === "place"
        ? Store
        : Wallet;
  return (
    <div className="flex min-w-0 items-center gap-2 overflow-hidden rounded-lg border border-input bg-muted/30 px-2.5 py-1.5">
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{selected.label}</div>
        <div
          className="truncate font-mono text-xs text-muted-foreground"
          title={selected.account}
        >
          {shortAddress(selected.account)}
        </div>
      </div>
      <button
        type="button"
        onClick={onClear}
        className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        aria-label={clearLabel}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

function Dropdown({
  rows,
  activeIndex,
  loading,
  hint,
  labels,
  onPick,
  onHover,
}: {
  rows: Row[];
  activeIndex: number;
  loading: boolean;
  hint: string | null;
  labels: RecipientPickerLabels;
  onPick: (row: Row) => void;
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
      {!loading && rows.length === 0 && hint && (
        <div className="px-3 py-2 text-xs text-muted-foreground">{hint}</div>
      )}
      {rows.map((row, i) => (
        <button
          key={
            row.kind === "hit"
              ? `${row.hit.kind}:${row.hit.id}`
              : `ext:${row.account}`
          }
          type="button"
          role="option"
          aria-selected={i === activeIndex}
          onMouseDown={(e) => {
            // mousedown (not click) so the input's blur doesn't close us first.
            e.preventDefault();
            onPick(row);
          }}
          onMouseEnter={() => onHover(i)}
          className={cn(
            "flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors",
            i === activeIndex ? "bg-muted" : "hover:bg-muted/60",
          )}
        >
          {row.kind === "hit" ? (
            <HitRow hit={row.hit} labels={labels} />
          ) : (
            <ExternalRow account={row.account} labels={labels} />
          )}
        </button>
      ))}
    </div>
  );
}

function HitRow({
  hit,
  labels,
}: {
  hit: RecipientHit;
  labels: RecipientPickerLabels;
}) {
  const Icon = hit.kind === "card" ? User : Store;
  const badge = hit.kind === "card" ? labels.card : labels.place;
  return (
    <>
      <Icon className="size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{hit.label}</div>
        <div className="truncate font-mono text-xs text-muted-foreground">
          {hit.sublabel ? `${hit.sublabel} · ` : ""}
          {hit.account}
        </div>
      </div>
      <Badge variant="outline" className="shrink-0">
        {badge}
      </Badge>
    </>
  );
}

function ExternalRow({
  account,
  labels,
}: {
  account: string;
  labels: RecipientPickerLabels;
}) {
  return (
    <>
      <Wallet className="size-4 shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{labels.external}</div>
        <div className="truncate font-mono text-xs text-muted-foreground">
          {account}
        </div>
      </div>
      <Badge variant="warning" className="shrink-0">
        {labels.external}
      </Badge>
    </>
  );
}
