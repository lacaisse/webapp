// SPDX-License-Identifier: AGPL-3.0-or-later

// One stacked horizontal bar (segments separated by 2px gaps that show the
// card surface) plus a legend row: dot, label, count. Colours are assigned by
// segment position from a fixed, colour-blind-safe order.

const SEGMENT_COLORS = [
  "var(--chart-1)",
  "var(--chart-4)",
  "var(--chart-3)",
  "var(--chart-5)",
  "var(--chart-2)",
] as const;

export type StatusSegment = { label: string; count: number };

export function StatusBreakdown({
  segments,
  emptyLabel,
  ariaLabel,
}: {
  segments: StatusSegment[];
  emptyLabel: string;
  ariaLabel: string;
}) {
  const shown = segments
    .filter((s) => s.count > 0)
    .map((s, i) => ({
      ...s,
      color: SEGMENT_COLORS[i % SEGMENT_COLORS.length],
    }));
  const total = shown.reduce((sum, s) => sum + s.count, 0);

  if (total === 0) {
    return <p className="text-sm text-muted-foreground">{emptyLabel}</p>;
  }

  return (
    <div className="space-y-3">
      <div
        role="img"
        aria-label={`${ariaLabel}: ${shown.map((s) => `${s.label} ${s.count}`).join(", ")}`}
        className="flex h-3 w-full gap-[2px] overflow-hidden rounded-full"
      >
        {shown.map((s) => (
          <div
            key={s.label}
            title={`${s.label}: ${s.count}`}
            className="h-full min-w-[3px]"
            style={{ flex: `${s.count} 1 0%`, background: s.color }}
          />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-xs">
        {shown.map((s) => (
          <li key={s.label} className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="size-2 rounded-full"
              style={{ background: s.color }}
            />
            <span className="text-muted-foreground">{s.label}</span>
            <span className="font-medium tabular-nums">{s.count}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
