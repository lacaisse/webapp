// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useLayoutEffect, useMemo, useRef, useState } from "react";

// Inline-SVG grouped bar chart (1 or 2 series), no charting library.
//
// Props are serialisable on purpose (this is rendered from server
// components): labels arrive pre-formatted, and numbers are formatted here
// with Intl.NumberFormat from a plain `valueFormat` descriptor — a formatter
// function could not cross the RSC boundary. A series may carry its own
// format when the two series are in different units (e.g. € vs token).
//
// The SVG's viewBox tracks the rendered width (ResizeObserver), so one
// viewBox unit = one CSS pixel: text stays at its real size on narrow cards
// and the HTML tooltip can be positioned from bar coordinates directly.

export type ValueFormat = {
  style: "decimal" | "currency";
  currency?: string;
  locale: string;
  suffix?: string;
};

export type BarChartDatum = {
  label: string;
  // Longer label for the tooltip (e.g. "October 2026" vs axis "Oct").
  fullLabel?: string;
  values: number[];
};

export type BarChartSeries = {
  name: string;
  color: string;
  format?: ValueFormat;
};

const MARGIN = { top: 22, right: 20, bottom: 24, left: 48 };
const BAR_GAP = 2;
const RADIUS = 4;
const DEFAULT_WIDTH = 560;

function makeFormatter(f: ValueFormat, compact: boolean) {
  let nf: Intl.NumberFormat;
  try {
    nf = new Intl.NumberFormat(f.locale, {
      style: f.style,
      currency: f.style === "currency" ? (f.currency ?? "EUR") : undefined,
      notation: compact ? "compact" : "standard",
      maximumFractionDigits: compact ? 1 : 2,
    });
  } catch {
    nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
  }
  return (n: number) => `${nf.format(n)}${f.suffix ? ` ${f.suffix}` : ""}`;
}

// 0 plus 2–3 "nice" ticks (1/2/2.5/5 × 10^k) covering max. Integer data
// (counts) never gets fractional ticks.
function niceTicks(max: number, integer: boolean): number[] {
  if (max <= 0) return [0, 1];
  const rough = max / 3;
  const mag = 10 ** Math.floor(Math.log10(rough));
  let step =
    [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= rough) ??
    10 * mag;
  if (integer) step = Math.max(1, Math.ceil(step));
  const top = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
  return ticks;
}

// Bar path with rounded top corners only.
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

export function BarChart({
  data,
  series,
  valueFormat,
  height = 220,
  ariaLabel,
  emptyLabel,
}: {
  data: BarChartDatum[];
  series: BarChartSeries[];
  valueFormat: ValueFormat;
  height?: number;
  ariaLabel: string;
  emptyLabel: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  const [hover, setHover] = useState<{ g: number; s: number } | null>(null);

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

  const fmt = useMemo(() => {
    const axis = makeFormatter(valueFormat, true);
    const perSeries = series.map((s) => ({
      compact: makeFormatter(s.format ?? valueFormat, true),
      full: makeFormatter(s.format ?? valueFormat, false),
    }));
    return { axis, perSeries };
  }, [valueFormat, series]);

  const nSeries = Math.max(1, Math.min(series.length, 2));
  const max = Math.max(
    0,
    ...data.flatMap((d) => d.values.slice(0, nSeries).map((v) => v || 0)),
  );
  const isEmpty = data.length === 0 || max <= 0;

  if (isEmpty) {
    return (
      <div ref={wrapRef}>
        <div
          className="flex items-center justify-center text-sm text-muted-foreground"
          style={{ height }}
        >
          {emptyLabel}
        </div>
      </div>
    );
  }

  const integer = data.every((d) => d.values.every(Number.isInteger));
  const ticks = niceTicks(max, integer);
  const top = ticks[ticks.length - 1] || 1;
  const plotW = Math.max(1, width - MARGIN.left - MARGIN.right);
  const plotH = Math.max(1, height - MARGIN.top - MARGIN.bottom);
  const band = plotW / data.length;
  const groupW = Math.min(band * 0.72, 28 * nSeries + BAR_GAP * (nSeries - 1));
  const barW = Math.max(1, (groupW - BAR_GAP * (nSeries - 1)) / nSeries);
  const y = (v: number) => MARGIN.top + plotH - (v / top) * plotH;

  // Which bars get a direct value label: the max bar of each series, and
  // every bar of the last group.
  const labelled = new Set<string>();
  for (let s = 0; s < nSeries; s++) {
    let best = -1;
    let bestV = 0;
    data.forEach((d, g) => {
      const v = d.values[s] ?? 0;
      if (v > bestV) {
        bestV = v;
        best = g;
      }
    });
    if (best >= 0) labelled.add(`${best}:${s}`);
    if ((data[data.length - 1].values[s] ?? 0) > 0) {
      labelled.add(`${data.length - 1}:${s}`);
    }
  }

  // Skip x labels when bands get too narrow for them.
  const xEvery = Math.max(1, Math.ceil(34 / band));

  const bars = data.flatMap((d, g) => {
    const gx = MARGIN.left + g * band + (band - groupW) / 2;
    return Array.from({ length: nSeries }, (_, s) => {
      const v = Math.max(0, d.values[s] ?? 0);
      const x = gx + s * (barW + BAR_GAP);
      const by = y(v);
      return { g, s, v, x, y: by, h: MARGIN.top + plotH - by };
    });
  });

  // Direct labels; when two labels in one group sit at nearly the same
  // height, lift the upper one so they don't collide.
  const labels = bars
    .filter((b) => labelled.has(`${b.g}:${b.s}`))
    .map((b) => ({ ...b, ly: b.y - 5 }));
  for (let i = 1; i < labels.length; i++) {
    const a = labels[i - 1];
    const b = labels[i];
    if (a.g === b.g && Math.abs(a.ly - b.ly) < 12) {
      if (a.ly <= b.ly) a.ly = b.ly - 12;
      else b.ly = a.ly - 12;
    }
  }

  const hovered = hover
    ? bars.find((b) => b.g === hover.g && b.s === hover.s)
    : undefined;

  return (
    <div ref={wrapRef} className="space-y-2">
      {series.length > 1 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          {series.slice(0, 2).map((s) => (
            <span key={s.name} className="inline-flex items-center gap-1.5">
              <span
                aria-hidden
                className="size-2.5 rounded-[2px]"
                style={{ background: s.color }}
              />
              {s.name}
            </span>
          ))}
        </div>
      )}
      <div className="relative">
        <svg
          role="img"
          aria-label={ariaLabel}
          width="100%"
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          className="block overflow-visible"
          onMouseLeave={() => setHover(null)}
        >
          <title>{ariaLabel}</title>

          {/* Gridlines + y-axis ticks */}
          {ticks.map((tv) => (
            <g key={tv}>
              <line
                x1={MARGIN.left}
                x2={width - MARGIN.right}
                y1={y(tv)}
                y2={y(tv)}
                stroke="var(--border)"
                strokeOpacity={tv === 0 ? 1 : 0.7}
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

          {/* x labels */}
          {data.map((d, g) =>
            g % xEvery === (data.length - 1) % xEvery ? (
              <text
                key={g}
                x={MARGIN.left + g * band + band / 2}
                y={height - 6}
                textAnchor="middle"
                fontSize={11}
                fill="var(--muted-foreground)"
              >
                {d.label}
              </text>
            ) : null,
          )}

          {/* Bars */}
          {bars.map((b) => {
            const active = hover?.g === b.g && hover?.s === b.s;
            return (
              <path
                key={`${b.g}:${b.s}`}
                d={barPath(b.x, b.y, barW, b.h)}
                fill={series[b.s]?.color ?? "var(--chart-1)"}
                fillOpacity={active ? 1 : 0.9}
                style={{ transition: "fill-opacity 120ms" }}
              />
            );
          })}

          {/* Direct value labels */}
          {labels.map((b) => (
            <text
              key={`l${b.g}:${b.s}`}
              x={b.x + barW / 2}
              y={b.ly}
              textAnchor="middle"
              fontSize={11}
              fontWeight={500}
              fill="var(--foreground)"
              className="tabular-nums"
            >
              {fmt.perSeries[b.s].compact(b.v)}
            </text>
          ))}

          {/* Hit targets: full plot height per bar so small bars are
              hoverable; focusable for keyboard users. */}
          {bars.map((b) => (
            <rect
              key={`h${b.g}:${b.s}`}
              x={b.x - BAR_GAP / 2}
              y={MARGIN.top}
              width={barW + BAR_GAP}
              height={plotH}
              fill="transparent"
              tabIndex={0}
              aria-label={`${data[b.g].fullLabel ?? data[b.g].label} · ${series[b.s]?.name ?? ""}: ${fmt.perSeries[b.s].full(b.v)}`}
              onMouseEnter={() => setHover({ g: b.g, s: b.s })}
              onFocus={() => setHover({ g: b.g, s: b.s })}
              onBlur={() => setHover(null)}
              className="outline-none"
            />
          ))}
        </svg>

        {hovered && (
          <div
            role="tooltip"
            className="pointer-events-none absolute z-10 min-w-28 -translate-x-1/2 -translate-y-full rounded-md bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-md ring-1 ring-foreground/10"
            style={{
              left: Math.min(
                Math.max(hovered.x + barW / 2, 56),
                Math.max(56, width - 56),
              ),
              top: Math.max(hovered.y - 8, 0),
            }}
          >
            <div className="font-medium">
              {data[hovered.g].fullLabel ?? data[hovered.g].label}
            </div>
            <div className="flex items-center gap-1.5 whitespace-nowrap text-muted-foreground">
              <span
                aria-hidden
                className="size-2 rounded-[2px]"
                style={{ background: series[hovered.s]?.color }}
              />
              {series[hovered.s]?.name}
              <span className="ml-auto pl-2 font-medium tabular-nums text-foreground">
                {fmt.perSeries[hovered.s].full(hovered.v)}
              </span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
