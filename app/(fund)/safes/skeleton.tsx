// SPDX-License-Identifier: AGPL-3.0-or-later
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// Header (title + description + create CTA) shell for the Safes list.
export function SafesHeaderSkeleton() {
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="space-y-1">
        <Skeleton className="h-7 w-40" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>
      <Skeleton className="h-7 w-28" />
    </header>
  );
}

const COLUMNS = 6;

// Loading state for the Safes list table.
export function SafesTableSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {Array.from({ length: COLUMNS }).map((_, i) => (
            <TableHead key={i}>
              <Skeleton className="h-3.5 w-16" />
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {Array.from({ length: rows }).map((_, r) => (
          <TableRow key={r}>
            <TableCell>
              <Skeleton className="h-3.5 w-28" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-3.5 w-32" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-3.5 w-6" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-3.5 w-12" />
            </TableCell>
            <TableCell>
              <Skeleton className="ml-auto h-3.5 w-16" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-4 w-14" />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

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
