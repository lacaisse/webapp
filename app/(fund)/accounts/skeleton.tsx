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

// Header (title + description) shell shared by the accounts pages.
export function AccountsHeaderSkeleton() {
  return (
    <div className="space-y-1">
      <Skeleton className="h-7 w-40" />
      <Skeleton className="h-4 w-72" />
    </div>
  );
}

// Loading state for the accounts list table (name / address / balance).
export function AccountsTableSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>
            <Skeleton className="h-3.5 w-16" />
          </TableHead>
          <TableHead>
            <Skeleton className="h-3.5 w-20" />
          </TableHead>
          <TableHead className="text-right">
            <Skeleton className="ml-auto h-3.5 w-16" />
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {Array.from({ length: rows }).map((_, r) => (
          <TableRow key={r}>
            <TableCell>
              <Skeleton className="h-3.5 w-32" />
            </TableCell>
            <TableCell>
              <Skeleton className="h-3.5 w-40" />
            </TableCell>
            <TableCell className="text-right">
              <Skeleton className="ml-auto h-3.5 w-20" />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// Loading state for the single-account detail page.
export function AccountDetailSkeleton() {
  return (
    <div className="space-y-6">
      <Skeleton className="h-4 w-24" />
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-3 w-80 max-w-full" />
        </div>
        <Skeleton className="h-9 w-24" />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Skeleton className="h-20 w-full" />
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          <Skeleton className="h-9 w-24" />
          <Skeleton className="h-9 w-24" />
          <Skeleton className="h-9 w-24" />
        </div>
      </div>
      <div className="space-y-3">
        <Skeleton className="h-6 w-32" />
        <AccountsTableSkeleton rows={5} />
      </div>
    </div>
  );
}
