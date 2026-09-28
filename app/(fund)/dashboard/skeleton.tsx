// SPDX-License-Identifier: AGPL-3.0-or-later
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// Fallbacks for the dashboard's Suspense boundaries — one per section, shaped
// like what streams in so the layout doesn't jump.

export function DashboardHeaderSkeleton() {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="space-y-1">
        <Skeleton className="h-7 w-44" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <Skeleton className="h-8 w-60 rounded-lg" />
    </div>
  );
}

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

export function ChartCardSkeleton({ legend = false }: { legend?: boolean }) {
  return (
    <Card>
      <CardHeader className="space-y-2">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-3.5 w-64 max-w-full" />
      </CardHeader>
      <CardContent className="space-y-2 pb-2">
        {legend && <Skeleton className="h-3 w-56" />}
        <div className="flex h-[220px] items-end gap-2 pb-6 pl-12 pr-5 pt-6">
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

export function BreakdownCardSkeleton() {
  return (
    <Card>
      <CardHeader className="space-y-2">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-3.5 w-60 max-w-full" />
      </CardHeader>
      <CardContent className="space-y-4 pb-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="space-y-1.5">
            <div className="flex justify-between">
              <Skeleton className="h-3.5 w-32" />
              <Skeleton className="h-3.5 w-16" />
            </div>
            <Skeleton className="h-2 w-full rounded-full" />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export function ActivitySkeleton() {
  return (
    <section className="space-y-3">
      <Skeleton className="h-6 w-40" />
      <Table>
        <TableHeader>
          <TableRow>
            {Array.from({ length: 4 }).map((_, i) => (
              <TableHead
                key={i}
                className={i === 3 ? "text-right" : undefined}
              >
                <Skeleton
                  className={i === 3 ? "ml-auto h-3.5 w-16" : "h-3.5 w-20"}
                />
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: 5 }).map((_, r) => (
            <TableRow key={r}>
              {Array.from({ length: 4 }).map((_, i) => (
                <TableCell
                  key={i}
                  className={i === 3 ? "text-right" : undefined}
                >
                  <Skeleton
                    className={i === 3 ? "ml-auto h-3.5 w-16" : "h-3.5 w-24"}
                  />
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

export function FooterSkeleton() {
  return <Skeleton className="h-3 w-72 max-w-full" />;
}
