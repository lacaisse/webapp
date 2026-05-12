import { getTranslations } from "next-intl/server";

type Column = {
  num: string;
  role: string;
  title: string;
  body: string;
  list: string[];
  highlight?: boolean;
};

export async function LandingHowItWorks() {
  const t = await getTranslations("landing.howItWorks");

  const columns: Column[] = [
    {
      num: "01",
      role: t("members.role"),
      title: t("members.title"),
      body: t("members.body"),
      list: t.raw("members.list") as string[],
    },
    {
      num: "02",
      role: t("team.role"),
      title: t("team.title"),
      body: t("team.body"),
      list: t.raw("team.list") as string[],
      highlight: true,
    },
    {
      num: "03",
      role: t("merchants.role"),
      title: t("merchants.title"),
      body: t("merchants.body"),
      list: t.raw("merchants.list") as string[],
    },
  ];

  return (
    <section className="pb-20 pt-4">
      <div className="mx-auto w-full max-w-[1240px] px-8 max-[760px]:px-5">
        <div className="mb-14 max-w-[900px]">
          <h2
            className="m-0 font-heading text-foreground"
            style={{
              fontSize: "clamp(36px, 4.5vw, 56px)",
              lineHeight: 1.05,
              fontWeight: 400,
              fontVariationSettings: '"opsz" 144, "SOFT" 50',
              textWrap: "pretty",
            }}
          >
            {t("title")}
          </h2>
          <p
            className="mb-0 mt-6 max-w-[720px] text-lg leading-relaxed"
            style={{
              color: "var(--muted-foreground)",
              textWrap: "pretty",
            }}
          >
            {t("intro")}
          </p>
        </div>

        <div className="grid grid-cols-3 gap-6 max-[900px]:grid-cols-1">
          {columns.map((c) => (
            <article
              key={c.num}
              className="flex flex-col gap-4 rounded-xl px-7 pb-7 pt-8"
              style={{
                background: c.highlight ? "var(--muted)" : "var(--card)",
                boxShadow: "0 0 0 1px var(--hairline)",
              }}
            >
              <div className="mb-2 flex items-baseline justify-between">
                <div
                  className="font-mono text-[11px]"
                  style={{
                    color: "var(--muted-foreground)",
                    letterSpacing: "0.06em",
                  }}
                >
                  {c.num} · {c.role.toUpperCase()}
                </div>
                <span
                  className="size-2 rounded-full"
                  style={{
                    background: c.highlight
                      ? "var(--primary)"
                      : "var(--border)",
                  }}
                />
              </div>
              <h3
                className="m-0 font-heading text-foreground"
                style={{
                  fontSize: 28,
                  lineHeight: 1.08,
                  fontWeight: 400,
                  letterSpacing: "-0.01em",
                  textWrap: "balance",
                }}
              >
                {c.title}
              </h3>
              <p
                className="m-0 leading-relaxed"
                style={{
                  fontSize: 14.5,
                  color: "var(--muted-foreground)",
                  textWrap: "pretty",
                }}
              >
                {c.body}
              </p>
              <ul
                className="m-0 mt-2 flex list-none flex-col gap-2 border-t pt-4"
                style={{ borderColor: "var(--hairline)", padding: 0 }}
              >
                {c.list.map((item) => (
                  <li
                    key={item}
                    className="flex items-baseline gap-2.5 text-foreground"
                    style={{ fontSize: 13.5, lineHeight: 1.45 }}
                  >
                    <span
                      className="size-1 shrink-0 rounded-sm"
                      style={{
                        background: c.highlight
                          ? "var(--primary)"
                          : "var(--foreground)",
                        transform: "translateY(-2px)",
                      }}
                    />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>

        <div className="mt-14">
          <div className="mb-1 flex items-center gap-2.5">
            <span className="lp-dot lp-dot-pulse" />
            <span className="lp-eyebrow">{t("loopEyebrow")}</span>
          </div>
          <MoneyLoop
            labels={{
              contributions: t("loop.contributions"),
              fundBalance: t("loop.fundBalance"),
              memberSpending: t("loop.memberSpending"),
              merchantPayouts: t("loop.merchantPayouts"),
            }}
          />
          <p
            id="loop-caption"
            className="mx-auto mt-5 max-w-[640px] text-center leading-relaxed"
            style={{
              fontSize: 14.5,
              color: "var(--muted-foreground)",
              textWrap: "pretty",
            }}
          >
            {t("loopCaption")}
          </p>
        </div>
      </div>
    </section>
  );
}

function MoneyLoop({
  labels,
}: {
  labels: {
    contributions: string;
    fundBalance: string;
    memberSpending: string;
    merchantPayouts: string;
  };
}) {
  const nodes: Array<{ x: number; y: number; label: string[] }> = [
    { x: 240, y: 50, label: split(labels.contributions) },
    { x: 430, y: 210, label: split(labels.fundBalance) },
    { x: 240, y: 370, label: split(labels.memberSpending) },
    { x: 50, y: 210, label: split(labels.merchantPayouts) },
  ];

  // Arrows between nodes, gently bowing outward via the diamond's outer corners.
  const arrows = [
    "M 273.7 78.3 Q 430 50 396.3 181.7",
    "M 396.3 238.3 Q 430 370 273.7 341.7",
    "M 206.3 341.7 Q 50 370 83.7 238.3",
    "M 83.7 181.7 Q 50 50 206.3 78.3",
  ];

  // Motion track passes through node centers; the animated dot pauses at each.
  const loopTrack =
    "M 240 50 Q 430 50 430 210 Q 430 370 240 370 Q 50 370 50 210 Q 50 50 240 50";

  return (
    <figure className="m-0 flex justify-center pt-4">
      <svg
        role="img"
        aria-labelledby="loop-caption"
        viewBox="0 0 480 420"
        className="h-auto w-full max-w-[540px]"
      >
        <defs>
          <marker
            id="lp-loop-arrowhead"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="8"
            markerHeight="8"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--primary)" opacity="0.6" />
          </marker>
          <path id="lp-loop-track" d={loopTrack} />
        </defs>

        {arrows.map((d, i) => (
          <path
            key={i}
            d={d}
            fill="none"
            stroke="var(--primary)"
            strokeOpacity="0.55"
            strokeWidth="1.6"
            strokeLinecap="round"
            markerEnd="url(#lp-loop-arrowhead)"
          />
        ))}

        {nodes.map((n, i) => (
          <g key={i}>
            <circle
              cx={n.x}
              cy={n.y}
              r={38}
              fill="var(--primary)"
              fillOpacity="0.12"
              stroke="var(--primary)"
              strokeOpacity="0.4"
              strokeWidth="1"
            />
            <text
              x={n.x}
              y={n.y}
              textAnchor="middle"
              fontFamily="var(--font-sans), system-ui, sans-serif"
              fontSize="12.5"
              fill="var(--foreground)"
              style={{ letterSpacing: "-0.005em" }}
            >
              {n.label.length === 1 ? (
                <tspan x={n.x} dy="0.35em">
                  {n.label[0]}
                </tspan>
              ) : (
                <>
                  <tspan x={n.x} dy="-0.15em">
                    {n.label[0]}
                  </tspan>
                  <tspan x={n.x} dy="1.25em">
                    {n.label[1]}
                  </tspan>
                </>
              )}
            </text>
          </g>
        ))}

        <circle r="5" fill="var(--primary)" className="lp-loop-anim">
          <animateMotion
            dur="6.4s"
            repeatCount="indefinite"
            calcMode="linear"
            keyPoints="0;0;0.25;0.25;0.5;0.5;0.75;0.75;1;1"
            keyTimes="0;0.094;0.219;0.344;0.469;0.594;0.719;0.844;0.969;1"
          >
            <mpath href="#lp-loop-track" />
          </animateMotion>
        </circle>
      </svg>
    </figure>
  );
}

// Soft wrap of multi-word labels onto two lines so each fits inside the node.
function split(label: string): string[] {
  const parts = label.trim().split(/\s+/);
  if (parts.length <= 1) return parts;
  const mid = Math.ceil(parts.length / 2);
  return [parts.slice(0, mid).join(" "), parts.slice(mid).join(" ")];
}
