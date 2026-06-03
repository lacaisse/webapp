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

// Loading state for the payout views (drafts / pending / completed). Each
// waits on CitizenPay; wrapping the table in <Suspense> with this fallback
// lets the page shell + tabs stream immediately.
export function PayoutsSkeleton() {
  return (
    <div className="space-y-3">
      <span className="inline-block h-3 w-64 animate-pulse rounded bg-muted" />
      <SettlementTableSkeleton columns={5} />
    </div>
  );
}

function SettlementTableSkeleton({
  columns,
  rows = 4,
}: {
  columns: number;
  rows?: number;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {Array.from({ length: columns }).map((_, i) => (
            <TableHead key={i} className={i >= columns - 2 ? "text-right" : undefined}>
              <span className="inline-block h-3.5 w-16 animate-pulse rounded bg-muted" />
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {Array.from({ length: rows }).map((_, r) => (
          <TableRow key={r}>
            {Array.from({ length: columns }).map((_, i) => (
              <TableCell
                key={i}
                className={i >= columns - 2 ? "text-right" : undefined}
              >
                <span
                  className={cn(
                    "inline-block h-3.5 animate-pulse rounded bg-muted",
                    i >= columns - 2 ? "w-20" : "w-32",
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
