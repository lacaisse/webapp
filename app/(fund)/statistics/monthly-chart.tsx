// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useState } from "react";

import {
  BarChart,
  type BarChartDatum,
  type BarChartSeries,
  type ValueFormat,
} from "@/components/charts/bar-chart";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// Monthly contributions vs. spending at merchants: the dashboard's shared
// BarChart, plus a table view of the same rows. Everything arrives built and
// formatted by the server (labels, series, table cells), so this wrapper only
// owns the chart/table toggle.
//
// The toggle is local state on purpose: it is a view preference on one card,
// not navigation, and should not churn the URL or re-run the loaders.

export type MonthlyTableRow = {
  month: string; // formatted, e.g. "October 2026"
  contributions: string; // formatted EUR
  spent: string;
};

export function MonthlyChart({
  data,
  series,
  valueFormat,
  ariaLabel,
  emptyLabel,
  rows,
  labels,
}: {
  data: BarChartDatum[];
  series: BarChartSeries[];
  valueFormat: ValueFormat;
  ariaLabel: string;
  emptyLabel: string;
  rows: MonthlyTableRow[];
  labels: { month: string; showTable: string; showChart: string };
}) {
  const [view, setView] = useState<"chart" | "table">("chart");

  return (
    <div className="space-y-3">
      {rows.length > 0 && (
        <div className="flex justify-end">
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-pressed={view === "table"}
            onClick={() => setView(view === "chart" ? "table" : "chart")}
          >
            {view === "chart" ? labels.showTable : labels.showChart}
          </Button>
        </div>
      )}

      {view === "chart" || rows.length === 0 ? (
        <BarChart
          data={data}
          series={series}
          valueFormat={valueFormat}
          ariaLabel={ariaLabel}
          emptyLabel={emptyLabel}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{labels.month}</TableHead>
              <TableHead className="text-right">{series[0]?.name}</TableHead>
              <TableHead className="text-right">{series[1]?.name}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.month}>
                <TableCell className="text-sm">{r.month}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {r.contributions}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {r.spent}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
