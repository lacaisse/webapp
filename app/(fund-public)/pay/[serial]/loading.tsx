// SPDX-License-Identifier: AGPL-3.0-or-later
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

// Suspense fallback for the public cotisation payment page.
export default function Loading() {
  return (
    <div className="w-full max-w-2xl space-y-6">
      <Skeleton className="h-4 w-32" />
      <Card>
        <CardHeader className="items-center gap-2">
          <Skeleton className="h-6 w-64" />
          <Skeleton className="h-4 w-80" />
        </CardHeader>
        <CardContent className="grid gap-6 sm:grid-cols-2">
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
          <Skeleton className="mx-auto size-[220px]" />
        </CardContent>
      </Card>
    </div>
  );
}
