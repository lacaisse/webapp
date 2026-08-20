// SPDX-License-Identifier: AGPL-3.0-or-later
import { Skeleton } from "@/components/ui/skeleton";

// Group-level Suspense boundary for the widgets. Under Cache Components the
// layout's host guard reads headers(), which is runtime data — without a
// boundary above it the whole group is forced out of prerendering ("Next.js
// encountered runtime data during prerendering"). Every other route group in
// the app carries the same file for the same reason.

export default function EmbedLoading() {
  return (
    <div className="space-y-3 p-3">
      <div className="flex items-center gap-2 border-b pb-2">
        <Skeleton className="size-6 rounded" />
        <Skeleton className="h-4 w-32" />
      </div>
      <Skeleton className="h-9 w-40" />
      <Skeleton className="h-40 w-full" />
    </div>
  );
}
