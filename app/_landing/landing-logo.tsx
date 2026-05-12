// 6-circle grid logo, drawn inline so it scales/animates cleanly with the rest
// of the editorial type. Bottom-middle circle filled with the brand color.

export function LandingLogo({
  size = 28,
  animated = false,
}: {
  size?: number;
  animated?: boolean;
}) {
  const r = 4;
  const gap = 11;
  const stroke = 1.4;
  const w = gap * 2 + r * 2 + stroke;
  const h = gap + r * 2 + stroke + 6;
  const scale = size / h;
  const cx = (i: number) => stroke / 2 + r + (i % 3) * gap;
  const cy = (i: number) => stroke / 2 + r + Math.floor(i / 3) * gap;

  return (
    <svg
      width={w * scale}
      height={h * scale}
      viewBox={`0 0 ${w} ${h}`}
      style={{ display: "block" }}
      aria-label="La caisse"
    >
      {[0, 1, 2, 3, 4, 5].map((i) => {
        const filled = i === 4;
        return (
          <circle
            key={i}
            cx={cx(i)}
            cy={cy(i)}
            r={r}
            fill={filled ? "var(--primary)" : "none"}
            stroke={filled ? "none" : "var(--foreground)"}
            strokeWidth={stroke}
            className={animated && filled ? "lp-dot-pulse" : undefined}
          />
        );
      })}
      <rect
        x={stroke / 2}
        y={gap + r * 2 + stroke / 2 + 3.5}
        width={w - stroke}
        height={1.4}
        fill="var(--foreground)"
      />
    </svg>
  );
}
