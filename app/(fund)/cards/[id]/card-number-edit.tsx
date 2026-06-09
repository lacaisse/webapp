// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { setCardNumberAction } from "@/services/card/admin-actions";

// Inline edit for a card's per-fund number (the value encoded in the Belgian
// structured communication). Blank clears the number.
export function CardNumberEdit({
  cardId,
  initial,
}: {
  cardId: string;
  initial: number | null;
}) {
  const t = useTranslations("fund.cards.number");
  const [editing, setEditing] = useState(false);
  const [current, setCurrent] = useState<number | null>(initial);
  const [value, setValue] = useState(initial?.toString() ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const save = () => {
    setError(null);
    const trimmed = value.trim();
    const num = trimmed === "" ? null : Number(trimmed);
    startTransition(async () => {
      const res = await setCardNumberAction({ cardId, number: num });
      if ("error" in res) {
        setError(res.error);
        return;
      }
      setCurrent(num);
      setEditing(false);
    });
  };

  if (!editing) {
    return (
      <span className="inline-flex items-center gap-2">
        <span>{current ?? "—"}</span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setValue(current?.toString() ?? "");
            setError(null);
            setEditing(true);
          }}
        >
          {t("edit")}
        </Button>
      </span>
    );
  }

  return (
    <span className="inline-flex flex-col gap-1">
      <span className="inline-flex items-center gap-2">
        <Input
          type="number"
          min={1}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="h-7 w-24"
        />
        <Button size="sm" onClick={save} disabled={pending}>
          {pending ? t("saving") : t("save")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setEditing(false);
            setError(null);
          }}
          disabled={pending}
        >
          {t("cancel")}
        </Button>
      </span>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </span>
  );
}
