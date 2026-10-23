// SPDX-License-Identifier: AGPL-3.0-or-later
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// Fallbacks for the Statistics page's Suspense boundaries, shaped like what
// streams in so the layout doesn't jump when a range change re-suspends.

// Renders `count` tiles as siblings (no wrapper) so they flow into the
// parent KPI grid like the real tiles do.
export function KpiTileSkeleton({ count = 1 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <Card key={i} size="sm">
          <CardHeader className="space-y-2">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-7 w-20" />
          </CardHeader>
          <CardContent className="pb-3">
            <Skeleton className="h-3 w-32" />
          </CardContent>
        </Card>
      ))}
    </>
  );
}

const BAR_HEIGHTS = [40, 65, 50, 80, 55, 70, 45, 90, 60, 75, 50, 85];

export function ChartCardSkeleton() {
  return (
    <Card>
      <CardHeader className="space-y-2">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-3.5 w-64 max-w-full" />
      </CardHeader>
      <CardContent className="space-y-3 pb-2">
        <div className="flex items-center justify-between">
          <Skeleton className="h-3 w-56 max-w-[60%]" />
          <Skeleton className="h-7 w-24 rounded-lg" />
        </div>
        <div className="flex h-[240px] items-end gap-2 pb-6 pl-14 pr-2 pt-3">
          {BAR_HEIGHTS.map((h, i) => (
            <Skeleton
              key={i}
              className="flex-1 rounded-b-none"
              style={{ height: `${h}%` }}
            />
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

const MERCHANT_COLUMNS = 5;

export function MerchantsCardSkeleton() {
  return (
    <Card>
      <CardHeader className="space-y-2">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-3.5 w-60 max-w-full" />
      </CardHeader>
      <CardContent className="pb-4">
        <Table>
          <TableHeader>
            <TableRow>
              {Array.from({ length: MERCHANT_COLUMNS }).map((_, i) => (
                <TableHead key={i} className={i > 0 ? "text-right" : undefined}>
                  <Skeleton
                    className={i > 0 ? "ml-auto h-3.5 w-14" : "h-3.5 w-24"}
                  />
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from({ length: 5 }).map((_, r) => (
              <TableRow key={r}>
                {Array.from({ length: MERCHANT_COLUMNS }).map((_, i) => (
                  <TableCell
                    key={i}
                    className={i > 0 ? "text-right" : undefined}
                  >
                    <Skeleton
                      className={i > 0 ? "ml-auto h-3.5 w-14" : "h-3.5 w-32"}
                    />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
