// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useTranslations } from "next-intl";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

import { Checkbox } from "@/components/ui/checkbox";

// Client-side row selection for the (server-rendered) member table. The
// provider wraps the toolbar + table so the bulk-action bar and the per-row
// checkboxes share one selection Set. The server passes `allIds` (every row
// currently shown) and keys the provider on the active tab+query, so switching
// filter remounts this and clears any stale selection.

type SelectionContextValue = {
  allIds: string[];
  selected: Set<string>;
  toggle: (id: string) => void;
  toggleAll: () => void;
  clear: () => void;
};

const SelectionContext = createContext<SelectionContextValue | null>(null);

export function MemberSelectionProvider({
  allIds,
  children,
}: {
  allIds: string[];
  children: ReactNode;
}) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAll = useCallback(() => {
    setSelected((prev) =>
      prev.size === allIds.length && allIds.length > 0
        ? new Set()
        : new Set(allIds),
    );
  }, [allIds]);

  const clear = useCallback(() => setSelected(new Set()), []);

  const value = useMemo(
    () => ({ allIds, selected, toggle, toggleAll, clear }),
    [allIds, selected, toggle, toggleAll, clear],
  );

  return (
    <SelectionContext.Provider value={value}>
      {children}
    </SelectionContext.Provider>
  );
}

export function useMemberSelection() {
  const ctx = useContext(SelectionContext);
  if (!ctx) {
    throw new Error(
      "useMemberSelection must be used within a MemberSelectionProvider",
    );
  }
  return ctx;
}

// Header checkbox: checked when every row is selected, indeterminate on a
// partial selection.
export function SelectAllCheckbox() {
  const { allIds, selected, toggleAll } = useMemberSelection();
  const t = useTranslations("members.admin.bulk");
  const allChecked = allIds.length > 0 && selected.size === allIds.length;
  const indeterminate = selected.size > 0 && !allChecked;
  return (
    <Checkbox
      checked={allChecked}
      indeterminate={indeterminate}
      onCheckedChange={() => toggleAll()}
      aria-label={t("selectAll")}
    />
  );
}

export function RowCheckbox({ id }: { id: string }) {
  const { selected, toggle } = useMemberSelection();
  const t = useTranslations("members.admin.bulk");
  return (
    <Checkbox
      checked={selected.has(id)}
      onCheckedChange={() => toggle(id)}
      aria-label={t("selectRow")}
    />
  );
}
