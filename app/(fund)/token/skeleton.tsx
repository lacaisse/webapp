// SPDX-License-Identifier: AGPL-3.0-or-later
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

// Loading state for the token tables. Both tables wait on Alchemy + the
// CitizenPay places list, which can take a noticeable beat; wrapping the
// real tables in <Suspense fallback={<TableSkeleton ... />}> lets the page
// shell stream immediately while the data lands.

export function TableSkeleton({
  columns,
  rows = 10,
}: {
  columns: Array<{ label?: string; align?: "left" | "right"; width?: string }>;
  rows?: number;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {columns.map((c, i) => (
            <TableHead
              key={i}
              className={cn(c.width, c.align === "right" && "text-right")}
            >
              {c.label}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {Array.from({ length: rows }).map((_, r) => (
          <TableRow key={r}>
            {columns.map((c, i) => (
              <TableCell
                key={i}
                className={c.align === "right" ? "text-right" : undefined}
              >
                <span
                  className={cn(
                    "inline-block h-3.5 animate-pulse rounded bg-muted",
                    c.align === "right" ? "w-20" : "w-32",
                  )}
                />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
