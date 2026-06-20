// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { Search } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useRef, useState, useTransition } from "react";

import { Input } from "@/components/ui/input";

// URL-driven search input shared by the admin tables (members, cards).
// Debounces typing into `?q=…` (and clears `?page` so a fresh search lands
// on page 1). Re-syncs from the URL when it changes from outside (e.g. tab
// switch clears the query) so the input never holds a stale value.

const DEBOUNCE_MS = 250;

export function TableSearch({ placeholder }: { placeholder: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const currentQ = searchParams.get("q") ?? "";
  const [value, setValue] = useState(currentQ);
  const [, startTransition] = useTransition();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Re-sync from the URL when it changes from outside (e.g. a tab switch
  // clears `q`). Tracking the previous URL value and adjusting during render
  // is React's recommended alternative to a setState-in-effect.
  const [prevQ, setPrevQ] = useState(currentQ);
  if (currentQ !== prevQ) {
    setPrevQ(currentQ);
    setValue(currentQ);
  }

  function handleChange(next: string) {
    setValue(next);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      const params = new URLSearchParams(searchParams);
      if (next) params.set("q", next);
      else params.delete("q");
      params.delete("page");
      const qs = params.toString();
      startTransition(() => {
        router.replace(qs ? `?${qs}` : "?", { scroll: false });
      });
    }, DEBOUNCE_MS);
  }

  return (
    <div className="relative w-full max-w-xs">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        autoComplete="off"
        value={value}
        onChange={(e) => handleChange(e.target.value)}
        placeholder={placeholder}
        className="pl-8"
      />
    </div>
  );
}
