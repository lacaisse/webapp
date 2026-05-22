// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from "next/link";
import { ChevronRight, RotateCcw } from "lucide-react";

import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

// Forward-only paginator for the Alchemy-backed tables. Alchemy hands us
// an opaque `pageKey` for the next page (or nothing on the last page);
// it doesn't support jumping or going back. So we expose two affordances:
//   - "Newer" — drops the cursor entirely, returning to the first page.
//   - "Older" — sets ?cursor=<pageKey> if Alchemy returned one.
// Both are <Link> so they're shareable and survive SSR.

export function Pagination({
  tab,
  cursor,
  nextPageKey,
  labels,
}: {
  tab: string;
  cursor: string | null;
  nextPageKey: string | null;
  labels: { newer: string; older: string };
}) {
  if (!cursor && !nextPageKey) return null;

  return (
    <div className="flex items-center justify-end gap-2 pt-3">
      <Link
        href={{ query: { tab } }}
        scroll={false}
        aria-disabled={!cursor}
        tabIndex={cursor ? undefined : -1}
        className={cn(
          buttonVariants({ variant: "outline", size: "sm" }),
          !cursor && "pointer-events-none opacity-50",
        )}
      >
        <RotateCcw className="size-3.5" />
        {labels.newer}
      </Link>
      <Link
        href={{ query: { tab, cursor: nextPageKey ?? undefined } }}
        scroll={false}
        aria-disabled={!nextPageKey}
        tabIndex={nextPageKey ? undefined : -1}
        className={cn(
          buttonVariants({ variant: "outline", size: "sm" }),
          !nextPageKey && "pointer-events-none opacity-50",
        )}
      >
        {labels.older}
        <ChevronRight className="size-3.5" />
      </Link>
    </div>
  );
}
