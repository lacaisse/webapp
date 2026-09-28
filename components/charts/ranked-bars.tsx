// SPDX-License-Identifier: AGPL-3.0-or-later

// Up to five ranked rows: label, a thin bar scaled to the largest value, and
// the pre-formatted value right-aligned. Server-renderable (no interactivity).

export type RankedBarRow = {
  label: React.ReactNode;
  value: number;
  display: string;
};

export function RankedBars({
  rows,
  emptyLabel,
  max: maxRows = 5,
}: {
  rows: RankedBarRow[];
  emptyLabel: string;
  max?: number;
}) {
  const shown = rows.slice(0, maxRows);
  const top = Math.max(0, ...shown.map((r) => r.value));

  if (shown.length === 0 || top <= 0) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
  }

  return (
    <ol className="space-y-3">
      {shown.map((row, i) => (
        <li key={i} className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-3 text-sm">
            <span className="min-w-0 truncate">{row.label}</span>
            <span className="shrink-0 font-medium tabular-nums">
              {row.display}
            </span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full"
              style={{
                width: `${Math.max(1, (row.value / top) * 100)}%`,
                background: "var(--chart-1)",
              }}
            />
          </div>
        </li>
      ))}
    </ol>
  );
}
