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

export function DashboardHeaderSkeleton() {
  return (
    <div className="space-y-1">
      <Skeleton className="h-7 w-44" />
      <Skeleton className="h-4 w-80 max-w-full" />
    </div>
  );
}

export function KpiSkeleton() {
  return (
    <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <Card key={i} size="sm">
          <CardHeader className="space-y-2">
            <Skeleton className="h-3.5 w-24" />
            <Skeleton className="h-7 w-16" />
          </CardHeader>
          <CardContent className="pb-3">
            <Skeleton className="h-3 w-32" />
          </CardContent>
        </Card>
      ))}
    </section>
  );
}

export function TiersCitizenPaySkeleton() {
  return (
    <section className="grid gap-3 lg:grid-cols-2">
      {Array.from({ length: 2 }).map((_, i) => (
        <Card key={i}>
          <CardHeader className="space-y-2">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-3.5 w-56 max-w-full" />
          </CardHeader>
          <CardContent className="space-y-3 pb-4">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </CardContent>
        </Card>
      ))}
    </section>
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
