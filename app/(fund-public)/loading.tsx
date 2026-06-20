// SPDX-License-Identifier: AGPL-3.0-or-later
import { Skeleton } from "@/components/ui/skeleton";

// Suspense shell for the public fund-scoped pages (member / merchant / team
// signup, email verification, payout signing). Centered card placeholder.
export default function Loading() {
  return (
    <div className="w-full max-w-md space-y-4">
      <Skeleton className="h-7 w-48" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-2/3" />
      <div className="space-y-3 pt-2">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    </div>
  );
}
