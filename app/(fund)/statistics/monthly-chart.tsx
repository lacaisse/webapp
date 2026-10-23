// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocale } from "next-intl";

import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// Monthly contributions vs. spending at merchants: a grouped column chart in
// inline SVG with one shared EUR axis, plus a table view of the same rows.
//
// The viewBox tracks the measured width (ResizeObserver), so one viewBox unit
// is one CSS pixel and text keeps its real size on a 360px phone instead of
// being scaled with the plot. Series colours are the two fixed brand chart
// tokens (blue / yellow-orange), never --chart-1, which follows each fund's
// own primary and could clash with or duplicate the other series. Text always
// uses text tokens so labels stay legible whatever the series colour.
//
// The table toggle is local state on purpose: it is a view preference on one
// card, not navigation, and should not churn the URL or re-run the loaders.

export type MonthlyChartPoint = {
  month: string; // "YYYY-MM"
  contributions: string; // EUR decimal string
  spent: string;
};

export type MonthlyChartLabels = {
  contributions: string;
  spent: string;
  month: string;
  showTable: string;
  showChart: string;
  empty: string;
  aria: string;
};

const SERIES = [
  { key: "contributions", color: "var(--chart-4)" },
  { key: "spent", color: "var(--chart-3)" },
] as const;

const HEIGHT = 240;
const MARGIN = { top: 12, right: 8, bottom: 24, left: 56 };
const BAR_GAP = 2;
const MAX_BAR_W = 14;
const RADIUS = 4;
const DEFAULT_WIDTH = 560;
// Room one x label needs; beyond ~12 months, or when the card is narrow,
// only every nth month is labelled so labels never overlap.
const LABEL_W = 44;
const MAX_X_LABELS = 12;

// 0 plus "nice" steps (1/2/2.5/5 × 10^k) covering max — 4 to 5 gridlines.
function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1];
  const rough = max / 4;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const step =
    [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rough) ?? 10 * mag;
  const ticks: number[] = [];
  for (let v = 0; v < max + step; v += step) ticks.push(v);
  return ticks;
}

// Column path with rounded top corners only.
function barPath(x: number, y: number, w: number, h: number): string {
  if (h <= 0 || w <= 0) return "";
  const r = Math.min(RADIUS, w / 2, h);
  return [
    `M${x},${y + h}`,
    `V${y + r}`,
    `Q${x},${y} ${x + r},${y}`,
    `H${x + w - r}`,
    `Q${x + w},${y} ${x + w},${y + r}`,
    `V${y + h}`,
    "Z",
  ].join(" ");
}

function monthDate(key: string): Date {
  const [y, m] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1));
}

export function MonthlyChart({
  months,
  labels,
}: {
  months: MonthlyChartPoint[];
  labels: MonthlyChartLabels;
}) {
  const locale = useLocale();
  const [view, setView] = useState<"chart" | "table">("chart");

  const fmt = useMemo(() => {
    const spansYears =
      months.length > 0 &&
      months[0].month.slice(0, 4) !== months[months.length - 1].month.slice(0, 4);
    const short = new Intl.DateTimeFormat(locale, {
      month: "short",
      ...(spansYears ? { year: "2-digit" } : {}),
      timeZone: "UTC",
    });
    const long = new Intl.DateTimeFormat(locale, {
      month: "long",
      year: "numeric",
      timeZone: "UTC",
    });
    const eur = new Intl.NumberFormat(locale, { style: "currency", currency: "EUR" });
    const eurCompact = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "EUR",
      notation: "compact",
      maximumFractionDigits: 1,
    });
    return {
      shortMonth: (k: string) => short.format(monthDate(k)),
      longMonth: (k: string) => long.format(monthDate(k)),
      eur: (n: number) => eur.format(n),
      axis: (n: number) => eurCompact.format(n),
    };
  }, [locale, months]);

  const rows = useMemo(
    () =>
      months.map((m) => ({
        month: m.month,
        values: [Number(m.contributions) || 0, Number(m.spent) || 0] as const,
      })),
    [months],
  );

  const legend = (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
      {SERIES.map((s) => (
        <span key={s.key} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="size-2.5 rounded-[2px]"
            style={{ background: s.color }}
          />
          {labels[s.key]}
        </span>
      ))}
    </div>
  );

  if (months.length === 0) {
    return <p className="py-6 text-sm text-muted-foreground">{labels.empty}</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {view === "chart" ? legend : <span />}
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

      {view === "chart" ? (
        <ColumnPlot rows={rows} labels={labels} fmt={fmt} />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{labels.month}</TableHead>
              <TableHead className="text-right">{labels.contributions}</TableHead>
              <TableHead className="text-right">{labels.spent}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.month}>
                <TableCell className="text-sm">{fmt.longMonth(r.month)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {fmt.eur(r.values[0])}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {fmt.eur(r.values[1])}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

type Formatters = {
  shortMonth: (k: string) => string;
  longMonth: (k: string) => string;
  eur: (n: number) => string;
  axis: (n: number) => string;
};

function ColumnPlot({
  rows,
  labels,
  fmt,
}: {
  rows: { month: string; values: readonly [number, number] }[];
  labels: MonthlyChartLabels;
  fmt: Formatters;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [hover, setHover] = useState<{ g: number; x: number; y: number } | null>(
    null,
  );

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const update = () => {
      const w = Math.round(el.getBoundingClientRect().width);
      if (w > 0) setWidth(w);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Refunds can make a month's sales negative; columns start at zero and the
  // signed value still shows in the tooltip and the table.
  const max = Math.max(0, ...rows.flatMap((r) => r.values));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1] || 1;
  const plotW = Math.max(1, width - MARGIN.left - MARGIN.right);
  const plotH = HEIGHT - MARGIN.top - MARGIN.bottom;
  const band = plotW / rows.length;
  const barW = Math.max(2, Math.min(MAX_BAR_W, (band * 0.6 - BAR_GAP) / 2));
  const groupW = barW * 2 + BAR_GAP;
  const y = (v: number) => MARGIN.top + plotH - (Math.max(0, v) / top) * plotH;

  const maxLabels = Math.max(1, Math.min(MAX_X_LABELS, Math.floor(plotW / LABEL_W)));
  const every = Math.max(1, Math.ceil(rows.length / maxLabels));
  // Anchor on the latest month so the most recent one is always labelled.
  const lastIdx = rows.length - 1;

  const hovered = hover ? rows[hover.g] : undefined;

  return (
    <div ref={wrapRef} className="relative" onMouseLeave={() => setHover(null)}>
      <svg
        role="img"
        aria-label={labels.aria}
        width="100%"
        height={HEIGHT}
        viewBox={`0 0 ${width} ${HEIGHT}`}
        className="block"
      >
        <title>{labels.aria}</title>

        {ticks.map((tv) => (
          <g key={tv}>
            <line
              x1={MARGIN.left}
              x2={width - MARGIN.right}
              y1={y(tv)}
              y2={y(tv)}
              stroke="var(--border)"
              strokeOpacity={tv === 0 ? 1 : 0.6}
              strokeWidth={1}
              shapeRendering="crispEdges"
            />
            <text
              x={MARGIN.left - 8}
              y={y(tv)}
              dy="0.32em"
              textAnchor="end"
              fontSize={11}
              fill="var(--muted-foreground)"
              className="tabular-nums"
            >
              {fmt.axis(tv)}
            </text>
          </g>
        ))}

        {rows.map((r, g) =>
          (lastIdx - g) % every === 0 ? (
            <text
              key={r.month}
              x={MARGIN.left + g * band + band / 2}
              y={HEIGHT - 6}
              textAnchor="middle"
              fontSize={11}
              fill="var(--muted-foreground)"
            >
              {fmt.shortMonth(r.month)}
            </text>
          ) : null,
        )}

        {rows.map((r, g) => {
          const gx = MARGIN.left + g * band + (band - groupW) / 2;
          const dim = hover != null && hover.g !== g;
          return (
            <g
              key={r.month}
              opacity={dim ? 0.55 : 1}
              style={{ transition: "opacity 120ms" }}
            >
              {SERIES.map((s, i) => {
                const by = y(r.values[i]);
                return (
                  <path
                    key={s.key}
                    d={barPath(gx + i * (barW + BAR_GAP), by, barW, MARGIN.top + plotH - by)}
                    fill={s.color}
                  />
                );
              })}
            </g>
          );
        })}

        {/* One full-height hit target per month so small or zero columns are
            still hoverable; focusable for keyboard users. */}
        {rows.map((r, g) => (
          <rect
            key={r.month}
            x={MARGIN.left + g * band}
            y={MARGIN.top}
            width={band}
            height={plotH}
            fill="transparent"
            tabIndex={0}
            aria-label={`${fmt.longMonth(r.month)}: ${fmt.eur(r.values[0])} ${labels.contributions}, ${fmt.eur(r.values[1])} ${labels.spent}`}
            className="outline-none"
            onMouseMove={(e) => {
              const box = wrapRef.current?.getBoundingClientRect();
              if (!box) return;
              setHover({ g, x: e.clientX - box.left, y: e.clientY - box.top });
            }}
            onFocus={() =>
              setHover({
                g,
                x: MARGIN.left + g * band + band / 2,
                y: MARGIN.top + plotH / 3,
              })
            }
            onBlur={() => setHover(null)}
          />
        ))}
      </svg>

      {hover && hovered && (
        <div
          role="tooltip"
          className="pointer-events-none absolute z-10 rounded-md bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md ring-1 ring-foreground/10"
          style={tooltipPosition(hover, width)}
        >
          <div className="mb-0.5 font-medium">{fmt.longMonth(hovered.month)}</div>
          {SERIES.map((s, i) => (
            <div key={s.key} className="flex items-center gap-1.5 whitespace-nowrap">
              <span
                aria-hidden
                className="size-2 rounded-[2px]"
                style={{ background: s.color }}
              />
              <span className="font-medium tabular-nums text-foreground">
                {fmt.eur(hovered.values[i])}
              </span>
              <span className="text-muted-foreground">{labels[s.key]}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Beside the pointer, flipped to its left in the right half so the tooltip
// stays inside the card; vertically clamped to the plot.
function tooltipPosition(
  hover: { x: number; y: number },
  width: number,
): React.CSSProperties {
  const top = Math.min(Math.max(hover.y - 12, 0), HEIGHT - 72);
  return hover.x > width / 2
    ? { right: Math.max(0, width - hover.x + 12), top }
    : { left: hover.x + 12, top };
}
