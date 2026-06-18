// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  useTransition,
  type ReactNode,
} from "react";

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
import { setCardsStatusAction } from "@/services/card/admin-actions";

// Client-side row selection for the cards list. The table itself is
// server-rendered; this context lets the per-row checkboxes, the header
// select-all, and the bulk-action bar share one selection set without lifting
// the whole table to the client. The provider is keyed (in the server table) by
// tab/page/q so the selection resets on navigation.

type SelectionCtx = {
  isSelected: (id: string) => boolean;
  selectedCount: number;
  selectedIds: string[];
  toggle: (id: string) => void;
  setMany: (ids: string[], on: boolean) => void;
  clear: () => void;
};

const Ctx = createContext<SelectionCtx | null>(null);

function useCardSelection(): SelectionCtx {
  const ctx = useContext(Ctx);
  if (!ctx) {
    throw new Error("useCardSelection must be used within CardSelectionProvider");
  }
  return ctx;
}

export function CardSelectionProvider({ children }: { children: ReactNode }) {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const setMany = useCallback((ids: string[], on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);

  const clear = useCallback(() => setSelected(new Set()), []);

  const value = useMemo<SelectionCtx>(
    () => ({
      isSelected: (id) => selected.has(id),
      selectedCount: selected.size,
      selectedIds: [...selected],
      toggle,
      setMany,
      clear,
    }),
    [selected, toggle, setMany, clear],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

// One row's checkbox.
export function CardSelectCheckbox({
  id,
  label,
}: {
  id: string;
  label: string;
}) {
  const { isSelected, toggle } = useCardSelection();
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={isSelected(id)}
      onChange={() => toggle(id)}
      className="size-4 rounded border-input align-middle"
    />
  );
}

// Header checkbox: selects/deselects every card on the current page. Shows an
// indeterminate state when only some of the page's rows are selected.
export function CardSelectAllCheckbox({
  ids,
  label,
}: {
  ids: string[];
  label: string;
}) {
  const { isSelected, setMany } = useCardSelection();
  const allOn = ids.length > 0 && ids.every((id) => isSelected(id));
  const someOn = ids.some((id) => isSelected(id));
  return (
    <input
      type="checkbox"
      aria-label={label}
      checked={allOn}
      ref={(el) => {
        if (el) el.indeterminate = !allOn && someOn;
      }}
      onChange={(e) => setMany(ids, e.target.checked)}
      className="size-4 rounded border-input align-middle"
    />
  );
}

const STATUS_OPTIONS = ["ACTIVE", "INACTIVE", "BLOCKED"] as const;

// Sticky bar shown above the table when at least one card is selected: the
// selected count, a "change status" dialog, and a clear button.
export function CardsBulkBar() {
  const t = useTranslations("cards.admin.bulk");
  const tStatus = useTranslations("cards.admin.status");
  const { selectedCount, selectedIds, clear } = useCardSelection();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [nextStatus, setNextStatus] = useState<(typeof STATUS_OPTIONS)[number]>(
    "ACTIVE",
  );
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (selectedCount === 0) return null;

  function onOpenChange(next: boolean) {
    if (!next && pending) return;
    setOpen(next);
    setError(null);
  }

  function onApply() {
    setError(null);
    startTransition(async () => {
      const result = await setCardsStatusAction({
        cardIds: selectedIds,
        status: nextStatus,
      });
      if ("error" in result) {
        setError(result.error);
        return;
      }
      setOpen(false);
      clear();
      router.refresh();
    });
  }

  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-3 py-2">
      <span className="text-sm font-medium">
        {t("selected", { count: selectedCount })}
      </span>
      <div className="flex items-center gap-2">
        <Dialog open={open} onOpenChange={onOpenChange}>
          <DialogTrigger render={<Button variant="outline" size="sm" />}>
            {t("changeStatus")}
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t("dialogTitle")}</DialogTitle>
              <DialogDescription>
                {t("dialogDescription", { count: selectedCount })}
              </DialogDescription>
            </DialogHeader>
            <fieldset className="space-y-2">
              <legend className="sr-only">{tStatus("statusLabel")}</legend>
              {STATUS_OPTIONS.map((opt) => (
                <label
                  key={opt}
                  className="flex cursor-pointer items-start gap-3 rounded-md border border-border bg-card p-3 transition-colors hover:bg-muted/40 has-checked:border-primary"
                >
                  <input
                    type="radio"
                    name="bulk-card-status"
                    value={opt}
                    checked={nextStatus === opt}
                    onChange={() => setNextStatus(opt)}
                    className="mt-1 size-4 border-input"
                  />
                  <div className="flex-1 space-y-0.5">
                    <div className="text-sm font-medium">
                      {tStatus(`options.${opt}.label` as never)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {tStatus(`options.${opt}.description` as never)}
                    </div>
                  </div>
                </label>
              ))}
            </fieldset>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={pending}
              >
                {t("cancel")}
              </Button>
              <Button onClick={onApply} disabled={pending}>
                {pending ? t("applying") : t("apply")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        <Button variant="ghost" size="sm" onClick={clear} disabled={pending}>
          {t("clear")}
        </Button>
      </div>
    </div>
  );
}
