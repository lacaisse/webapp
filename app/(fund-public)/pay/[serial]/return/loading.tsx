// SPDX-License-Identifier: AGPL-3.0-or-later
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

// Suspense fallback for the top-up return page (bank redirect landing).
export default function Loading() {
  return (
    <div className="w-full max-w-xl space-y-6">
      <Skeleton className="ml-auto h-4 w-24" />
      <Card>
        <CardHeader className="items-center">
          <Skeleton className="mx-auto h-6 w-56" />
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-4 py-4">
          <Skeleton className="size-10 rounded-full" />
          <Skeleton className="h-5 w-64" />
          <Skeleton className="h-4 w-80" />
          <Skeleton className="h-9 w-32" />
        </CardContent>
      </Card>
    </div>
  );
}
