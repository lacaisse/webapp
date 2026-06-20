// SPDX-License-Identifier: AGPL-3.0-or-later
import { Skeleton } from "@/components/ui/skeleton";

// Suspense shell for the account-level pages (account settings, create-fund).
export default function Loading() {
  return (
    <div className="flex flex-1 items-start justify-center bg-muted/40 px-4 py-12">
      <div className="w-full max-w-2xl space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    </div>
  );
}
