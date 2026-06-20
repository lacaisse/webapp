// SPDX-License-Identifier: AGPL-3.0-or-later
import { Skeleton } from "@/components/ui/skeleton";

// Group-level instant shell for the fund admin pages: the Suspense boundary
// Cache Components needs for any fund page whose component suspends at its root
// (e.g. the pages that still await the fund/i18n context up top). Pages built
// as synchronous shells render their own header + section skeletons instead and
// never fall back to this generic one.
export default function Loading() {
  return (
    <>
      <div className="space-y-1">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-72" />
      </div>
      <Skeleton className="h-64 w-full" />
    </>
  );
}
