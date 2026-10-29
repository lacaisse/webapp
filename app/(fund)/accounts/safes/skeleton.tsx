// SPDX-License-Identifier: AGPL-3.0-or-later
import { Skeleton } from "@/components/ui/skeleton";

// Loading state for one pending transaction card / the history list.
export function SafeTxListSkeleton({ rows = 2 }: { rows?: number }) {
  return (
    <div className="space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-28 w-full rounded-xl" />
      ))}
    </div>
  );
}

// Loading state for the single-Safe detail page.
export function SafeDetailSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-4 w-24" />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-2">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-3.5 w-80 max-w-full" />
        </div>
        <div className="flex gap-2">
          <Skeleton className="h-7 w-24" />
          <Skeleton className="h-7 w-24" />
        </div>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
      <Skeleton className="h-48 w-full rounded-xl" />
      <div className="space-y-3">
        <Skeleton className="h-6 w-40" />
        <SafeTxListSkeleton />
      </div>
    </div>
  );
}
