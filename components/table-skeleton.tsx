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

// Generic table loading state used as a <Suspense> fallback while a data table
// streams in. `alignRight` marks trailing columns whose cells/headers are
// right-aligned (e.g. amounts).
export function TableSkeleton({
  columns,
  rows = 5,
  alignRight = 0,
}: {
  columns: number;
  rows?: number;
  alignRight?: number;
}) {
  const isRight = (i: number) => i >= columns - alignRight;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {Array.from({ length: columns }).map((_, i) => (
            <TableHead key={i} className={isRight(i) ? "text-right" : undefined}>
              <Skeleton
                className={isRight(i) ? "ml-auto h-3.5 w-12" : "h-3.5 w-16"}
              />
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {Array.from({ length: rows }).map((_, r) => (
          <TableRow key={r}>
            {Array.from({ length: columns }).map((_, i) => (
              <TableCell key={i} className={isRight(i) ? "text-right" : undefined}>
                <Skeleton
                  className={isRight(i) ? "ml-auto h-3.5 w-16" : "h-3.5 w-28"}
                />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
