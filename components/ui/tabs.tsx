// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from "next/link";

import { cn } from "@/lib/utils";

// URL-driven tabs: the active tab lives in a search param so back/forward and
// shareable links just work (per the project's routing convention). Server
// components decide which tab is active from `searchParams` and render the
// matching panel.

export type TabItem = {
  value: string;
  label: React.ReactNode;
};

export function Tabs({
  items,
  active,
  paramName = "tab",
  baseQuery,
  className,
}: {
  items: TabItem[];
  active: string;
  paramName?: string;
  // Extra query params to keep on every tab link. Without this a tab link
  // replaces the whole query string — fine for the top-level tab bar, but a
  // nested filter (e.g. ?tab=transactions&filter=unmatched) needs to preserve
  // the parent `tab` when it switches its own param.
  baseQuery?: Record<string, string>;
  className?: string;
}) {
  return (
    <div
      data-slot="tabs"
      role="tablist"
      className={cn(
        "inline-flex items-center gap-0.5 rounded-lg bg-muted p-0.5 text-sm",
        className,
      )}
    >
      {items.map((item) => {
        const isActive = item.value === active;
        return (
          <Link
            key={item.value}
            role="tab"
            aria-selected={isActive}
            scroll={false}
            href={{ query: { ...baseQuery, [paramName]: item.value } }}
            className={cn(
              "inline-flex h-7 items-center rounded-md px-3 font-medium transition-colors",
              isActive
                ? "bg-background text-foreground shadow-sm ring-1 ring-foreground/10"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </div>
  );
}

export function resolveActiveTab<T extends string>(
  raw: string | string[] | undefined,
  items: readonly { value: T }[],
): T {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return items.find((i) => i.value === value)?.value ?? items[0].value;
}
