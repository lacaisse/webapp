// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { Check, ChevronsUpDown, Loader2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useState, useTransition } from "react";

import { Combobox } from "@base-ui/react/combobox";

import { Badge } from "@/components/ui/badge";
import { setCardSourceAction } from "@/services/card/admin-actions";

// A card's pull-from source: another fund card, or a SOURCE token account.
export type SourceOption = {
  type: "card" | "account";
  id: string;
  serial: string;
  number: number | null; // card number; null for accounts
  name: string; // holder name / account name
};

const refId = (o: SourceOption) => `${o.type}:${o.id}`;

// Searchable picker for a card's source. Type to filter by card number, serial,
// or account/holder name; clear to remove the source. The relationship lives on
// CitizenPay — the page reads it back on re-render.
export function CardSourcePicker({
  cardId,
  currentRefId,
  // Set when CP reports a source serial we couldn't resolve to a local card or
  // account (e.g. deleted locally) — shown as-is so the admin sees it's set.
  unresolvedSourceSerial,
  options,
}: {
  cardId: string;
  currentRefId: string | null;
  unresolvedSourceSerial: string | null;
  options: SourceOption[];
}) {
  const t = useTranslations("fund.cards.detail.source");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const current = useMemo(
    () => options.find((o) => refId(o) === currentRefId) ?? null,
    [options, currentRefId],
  );
  const [value, setValue] = useState<SourceOption | null>(current);

  const label = (o: SourceOption) => {
    if (o.type === "card") {
      const num = o.number != null ? `#${o.number}` : null;
      return [num, o.name].filter(Boolean).join(" · ") || o.serial;
    }
    return o.name || o.serial;
  };

  // Haystack for multi-field search: number (with and without "#"), serial, name.
  const haystack = (o: SourceOption) =>
    [
      o.number != null ? `#${o.number}` : "",
      o.number ?? "",
      o.serial,
      o.name,
    ]
      .join(" ")
      .toLowerCase();

  const onChange = (next: SourceOption | null) => {
    const prev = value;
    setValue(next);
    setError(null);
    startTransition(async () => {
      const result = await setCardSourceAction({
        cardId,
        source: next ? { type: next.type, id: next.id } : null,
      });
      if ("error" in result) {
        setError(result.error);
        setValue(prev);
      }
    });
  };

  return (
    <div className="space-y-1">
      <Combobox.Root
        items={options}
        value={value}
        onValueChange={onChange}
        disabled={pending}
        itemToStringLabel={label}
        itemToStringValue={refId}
        filter={(item, query) => {
          const q = query.trim().toLowerCase();
          return q === "" || haystack(item).includes(q);
        }}
      >
        <div className="relative max-w-72">
          <Combobox.Input
            placeholder={
              unresolvedSourceSerial
                ? t("unresolved", { serial: unresolvedSourceSerial })
                : t("placeholder")
            }
            className="h-8 w-full rounded-md bg-background py-1 pr-14 pl-2 text-xs ring-1 ring-foreground/15 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          />
          <div className="absolute inset-y-0 right-1 flex items-center text-muted-foreground">
            {pending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Combobox.Clear
                aria-label={t("clear")}
                className="flex size-6 items-center justify-center rounded-sm hover:text-foreground"
              >
                <X className="size-3.5" />
              </Combobox.Clear>
            )}
            <Combobox.Trigger
              aria-label={t("open")}
              className="flex size-6 items-center justify-center rounded-sm hover:text-foreground"
            >
              <ChevronsUpDown className="size-3.5" />
            </Combobox.Trigger>
          </div>
        </div>

        <Combobox.Portal>
          <Combobox.Positioner sideOffset={4} className="z-50 outline-none">
            <Combobox.Popup className="w-[var(--anchor-width)] max-w-[var(--available-width)] origin-[var(--transform-origin)] rounded-md bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-none data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0">
              <Combobox.Empty className="px-2 py-3 text-center text-xs text-muted-foreground">
                {t("empty")}
              </Combobox.Empty>
              <Combobox.List className="max-h-[min(20rem,var(--available-height))] overflow-y-auto overscroll-contain">
                {(item: SourceOption) => (
                  <Combobox.Item
                    key={refId(item)}
                    value={item}
                    className="flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-xs outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground"
                  >
                    <Combobox.ItemIndicator className="shrink-0">
                      <Check className="size-3.5" />
                    </Combobox.ItemIndicator>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-medium">
                        {label(item)}
                      </span>
                      <span className="truncate font-mono text-[0.7rem] text-muted-foreground">
                        {item.serial}
                      </span>
                    </span>
                    <Badge variant="outline" className="shrink-0">
                      {item.type === "account" ? t("typeAccount") : t("typeCard")}
                    </Badge>
                  </Combobox.Item>
                )}
              </Combobox.List>
            </Combobox.Popup>
          </Combobox.Positioner>
        </Combobox.Portal>
      </Combobox.Root>

      <p className="text-xs text-muted-foreground">{t("hint")}</p>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
