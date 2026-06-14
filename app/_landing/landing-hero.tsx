// SPDX-License-Identifier: AGPL-3.0-or-later
"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";

type Swatch = {
  key: "terracotta" | "forest" | "indigo" | "plum" | "slate" | "ochre";
  hex: string;
  hue: number;
  oklch: string;
};

const SWATCHES: Swatch[] = [
  { key: "terracotta", hex: "#C46A4A", hue: 35, oklch: "oklch(0.58 0.13 35)" },
  { key: "forest", hex: "#4F8255", hue: 150, oklch: "oklch(0.58 0.13 150)" },
  { key: "indigo", hex: "#5B6BB8", hue: 270, oklch: "oklch(0.58 0.13 270)" },
  { key: "plum", hex: "#A05A8E", hue: 340, oklch: "oklch(0.58 0.13 340)" },
  { key: "slate", hex: "#637A8A", hue: 230, oklch: "oklch(0.58 0.04 230)" },
  { key: "ochre", hex: "#B58A2E", hue: 85, oklch: "oklch(0.58 0.13 85)" },
];

const DEFAULT_FUND = "Caisse de Saint-Gilles";
const DEFAULT_TOKEN = "solidaire";

export function LandingHero({ loginUrl }: { loginUrl: string }) {
  const t = useTranslations("landing.hero");
  const [fundName, setFundName] = useState(DEFAULT_FUND);
  const [tokenName, setTokenName] = useState(DEFAULT_TOKEN);
  const [color, setColor] = useState<Swatch>(SWATCHES[0]);

  const reset = () => {
    setFundName(DEFAULT_FUND);
    setTokenName(DEFAULT_TOKEN);
    setColor(SWATCHES[0]);
  };

  return (
    <section className="pt-14 pb-[72px]">
      <div className="mx-auto w-full max-w-[1240px] px-8 max-[760px]:px-5">
        <div
          className="grid items-center gap-16 [grid-template-columns:1.05fr_0.95fr] max-[1000px]:grid-cols-1 max-[1000px]:gap-12"
        >
          <div className="flex flex-col" style={{ maxWidth: 560 }}>
            <div
              className="lp-fade-in mb-7 inline-flex items-center gap-2.5 self-start"
            >
              <span
                className="inline-flex items-center font-mono"
                style={{
                  fontSize: 11,
                  border: "1px solid var(--border)",
                  borderRadius: 999,
                  padding: "0 12px",
                  height: 26,
                  color: "var(--muted-foreground)",
                }}
              >
                {t("badge")}
              </span>
            </div>

            <h1
              className="lp-fade-in lp-fade-in-1 m-0 font-heading text-foreground"
              style={{
                fontSize: "clamp(40px, 5.5vw, 72px)",
                lineHeight: 1.02,
                fontWeight: 400,
                letterSpacing: "-0.02em",
                fontVariationSettings: '"opsz" 144, "SOFT" 50',
              }}
            >
              {t("headlineBefore")}{" "}
              <span
                style={{
                  color: color.oklch,
                  transition: "color 280ms var(--ease-out)",
                  fontStyle: "italic",
                  fontVariationSettings: '"opsz" 144, "SOFT" 100',
                }}
              >
                {t("headlineItalic")}
              </span>{" "}
              {t("headlineAfter")}
            </h1>

            <p
              className="lp-fade-in lp-fade-in-2 mb-0 mt-7 max-w-[560px]"
              style={{
                fontSize: 19,
                lineHeight: 1.45,
                color: "var(--muted-foreground)",
                textWrap: "pretty",
              }}
            >
              <span className="text-foreground">{t("descriptionLead")}</span>{" "}
              {t.rich("description", {
                em: (chunks) => (
                  <em
                    className="font-heading"
                    style={{ fontStyle: "italic" }}
                  >
                    {chunks}
                  </em>
                ),
              })}
            </p>

            <div
              className="lp-fade-in lp-fade-in-3 mt-7 flex items-center gap-4 text-[13px]"
              style={{ color: "var(--muted-foreground)" }}
            >
              <a
                href={loginUrl}
                className="border-b text-foreground no-underline"
                style={{
                  borderColor: "var(--border)",
                  paddingBottom: 2,
                }}
              >
                {t("alreadyMember")} →
              </a>
            </div>

            <div
              className="lp-fade-in lp-fade-in-3 mt-10 w-full"
              style={{ maxWidth: 480 }}
            >
              <Configurator
                fundName={fundName}
                setFundName={setFundName}
                tokenName={tokenName}
                setTokenName={setTokenName}
                color={color}
                setColor={setColor}
                onReset={reset}
              />
            </div>
          </div>

          <div className="lp-fade-in lp-fade-in-4">
            <AdminPreview
              fundName={fundName}
              tokenName={tokenName}
              color={color}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

function Configurator({
  fundName,
  setFundName,
  tokenName,
  setTokenName,
  color,
  setColor,
  onReset,
}: {
  fundName: string;
  setFundName: (v: string) => void;
  tokenName: string;
  setTokenName: (v: string) => void;
  color: Swatch;
  setColor: (s: Swatch) => void;
  onReset: () => void;
}) {
  const t = useTranslations("landing.hero.configurator");
  const tSwatches = useTranslations("landing.hero.swatches");

  const [fundDraft, setFundDraft] = useState(fundName);
  const [tokenDraft, setTokenDraft] = useState(tokenName);
  const [touched, setTouched] = useState<{ fund?: boolean; token?: boolean }>({});

  const fundErr = (() => {
    const v = fundDraft.trim();
    if (!touched.fund) return null;
    if (!v) return t("errors.fundEmpty");
    if (v.length < 3) return t("errors.fundTooShort");
    if (v.length > 60) return t("errors.fundTooLong");
    return null;
  })();
  const tokenErr = (() => {
    const v = tokenDraft.trim();
    if (!touched.token) return null;
    if (!v) return t("errors.tokenEmpty");
    if (v.length > 20) return t("errors.tokenTooLong");
    if (/\s/.test(v)) return t("errors.tokenMultiWord");
    return null;
  })();
  return (
    <div
      className="rounded-xl p-6"
      style={{
        background: "var(--card)",
        boxShadow:
          "0 0 0 1px var(--hairline), 0 1px 0 oklch(0.18 0.012 75 / 0.04)",
      }}
    >
      <div
        className="mb-5 flex items-center justify-between border-b pb-4"
        style={{ borderColor: "var(--hairline)" }}
      >
        <div className="flex items-center gap-2.5">
          <span className="lp-dot lp-dot-pulse" />
          <div className="lp-eyebrow">{t("eyebrow")}</div>
        </div>
        <button
          type="button"
          onClick={() => {
            onReset();
            setFundDraft(DEFAULT_FUND);
            setTokenDraft(DEFAULT_TOKEN);
            setTouched({});
          }}
          className="border-b border-transparent bg-transparent p-0 text-xs transition-colors hover:border-[var(--border)] hover:text-foreground"
          style={{ color: "var(--muted-foreground)" }}
        >
          {t("reset")}
        </button>
      </div>

      <div className="flex flex-col gap-4">
        <Field
          id="lp-fund-name"
          label={t("fundName")}
          value={fundDraft}
          onChange={setFundDraft}
          onBlur={() => {
            setTouched((s) => ({ ...s, fund: true }));
            setFundName(fundDraft);
          }}
          placeholder={DEFAULT_FUND}
          maxLength={60}
          helper={t("fundNameHelper")}
          error={fundErr}
        />

        <div>
          <label className="mb-1.5 block text-[13px] font-medium text-foreground">
            {t("primaryColor")}
          </label>
          <ColorPicker value={color} onChange={setColor} />
          <div
            className="mt-2 text-xs"
            style={{ color: "var(--muted-foreground)" }}
          >
            <span className="text-foreground">{tSwatches(color.key)}</span>{" "}
            —{" "}
            {color.key === "terracotta"
              ? t("swatchHelperDefault")
              : t("swatchHelperOther")}
          </div>
        </div>

        <Field
          id="lp-token-name"
          label={t("tokenName")}
          value={tokenDraft}
          onChange={setTokenDraft}
          onBlur={() => {
            setTouched((s) => ({ ...s, token: true }));
            setTokenName(tokenDraft);
          }}
          placeholder={DEFAULT_TOKEN}
          maxLength={20}
          helper={t("tokenNameHelper")}
          error={tokenErr}
        />

        <div className="mt-1 flex flex-col gap-2.5 pt-2">
          <a
            href="#get-started"
            className="inline-flex h-11 w-full items-center justify-between rounded-lg px-[18px] text-[15px] font-medium text-primary-foreground no-underline transition-opacity hover:opacity-90"
            style={{
              background: color.oklch,
              border: "1px solid transparent",
              transition:
                "background 280ms var(--ease-out), opacity 120ms var(--ease-out)",
            }}
          >
            <span>{t("joinWaitlist")}</span>
            <span>→</span>
          </a>
        </div>
      </div>
    </div>
  );
}

function ColorPicker({
  value,
  onChange,
}: {
  value: Swatch;
  onChange: (s: Swatch) => void;
}) {
  const tSwatches = useTranslations("landing.hero.swatches");
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2.5">
        <div className="flex gap-1.5">
          {SWATCHES.map((s) => {
            const on = s.hue === value.hue && s.key === value.key;
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => onChange(s)}
                aria-label={tSwatches(s.key)}
                title={tSwatches(s.key)}
                className="size-7 cursor-pointer rounded-full border-0 p-0 transition-transform hover:-translate-y-px"
                style={{
                  background: s.oklch,
                  boxShadow: on
                    ? `0 0 0 2px var(--background), 0 0 0 3.5px ${s.oklch}`
                    : "0 0 0 1px oklch(0.18 0.012 75 / 0.12)",
                }}
              />
            );
          })}
        </div>
        <div
          className="flex h-10 flex-1 items-center gap-2 rounded-md border px-3 font-mono text-[13px]"
          style={{
            background: "var(--card)",
            borderColor: "var(--border)",
            color: "var(--muted-foreground)",
          }}
        >
          <span
            className="rounded-sm"
            style={{
              width: 12,
              height: 12,
              background: value.oklch,
              transition: "background 280ms var(--ease-out)",
            }}
          />
          <span className="text-foreground">{value.hex}</span>
        </div>
      </div>
    </div>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
  onBlur,
  placeholder,
  maxLength,
  helper,
  error,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  onBlur: () => void;
  placeholder: string;
  maxLength: number;
  helper: string;
  error: string | null;
}) {
  return (
    <div>
      <label
        className="mb-1.5 block text-[13px] font-medium text-foreground"
        htmlFor={id}
      >
        {label}
      </label>
      <input
        id={id}
        className="h-10 w-full rounded-md border px-3 font-sans text-[15px] text-foreground outline-none transition-shadow focus:border-[var(--primary)] focus:ring-3 focus:ring-[var(--primary-tint)]"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder={placeholder}
        maxLength={maxLength}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-err` : `${id}-help`}
        style={{
          background: "var(--card)",
          borderColor: error ? "oklch(0.55 0.20 27)" : "var(--border)",
          boxShadow: error ? "0 0 0 3px oklch(0.55 0.20 27 / 0.1)" : undefined,
        }}
      />
      {error ? (
        <div
          id={`${id}-err`}
          className="mt-1.5 flex items-start gap-1.5 text-xs"
          style={{ color: "oklch(0.55 0.20 27)" }}
        >
          <span
            className="mt-1.5 inline-block shrink-0 rounded-sm"
            style={{
              width: 4,
              height: 4,
              background: "oklch(0.55 0.20 27)",
            }}
          />
          <span>{error}</span>
        </div>
      ) : (
        <div
          id={`${id}-help`}
          className="mt-1.5 text-xs"
          style={{ color: "var(--muted-foreground)" }}
        >
          {helper}
        </div>
      )}
    </div>
  );
}

function AdminPreview({
  fundName,
  tokenName,
  color,
}: {
  fundName: string;
  tokenName: string;
  color: Swatch;
}) {
  const t = useTranslations("landing.hero.preview");
  const skin: React.CSSProperties = {
    // primary + derived tints feed every accent below
    ["--ap-primary" as never]: color.oklch,
    ["--ap-primary-tint" as never]: `oklch(0.58 0.13 ${color.hue} / 0.10)`,
    ["--ap-primary-soft" as never]: `oklch(0.58 0.13 ${color.hue} / 0.22)`,
    ["--ap-primary-deep" as never]: `oklch(0.42 0.12 ${color.hue})`,
  };

  const initial = (fundName.trim().charAt(0) || "F").toUpperCase();
  const subdomain = (fundName || "your-fund")
    .toLowerCase()
    .replace(/\s+/g, "-");

  const sidebarItems: Array<{ l: string; on?: boolean }> = [
    { l: t("nav.overview"), on: true },
    { l: t("nav.members") },
    { l: t("nav.allocations") },
    { l: t("nav.merchants") },
    { l: t("nav.transactions") },
    { l: t("nav.settings") },
  ];

  const kpis = [
    {
      label: t("kpi.members"),
      value: "248",
      delta: t("kpi.membersDelta"),
      positive: true,
    },
    {
      label: t("kpi.tokensInCirculation", { token: tokenName || "tokens" }),
      value: "14,820",
      delta: t("kpi.tokensDelta"),
      positive: false,
      num: true,
    },
    {
      label: t("kpi.merchants"),
      value: "37",
      delta: t("kpi.merchantsDelta"),
      positive: false,
    },
  ];

  return (
    <div
      className="relative overflow-hidden rounded-[14px] text-xs"
      style={{
        ...skin,
        background: "var(--card)",
        boxShadow:
          "0 0 0 1px var(--hairline), 0 24px 48px -24px oklch(0.18 0.012 75 / 0.18), 0 8px 16px -8px oklch(0.18 0.012 75 / 0.08)",
        transition: "box-shadow 280ms var(--ease-out)",
      }}
    >
      <div
        className="flex h-7 items-center gap-1.5 border-b px-2.5"
        style={{
          borderColor: "var(--hairline)",
          background: "var(--muted)",
        }}
      >
        <span
          className="size-[9px] rounded-full"
          style={{ background: "#e1c8c0" }}
        />
        <span
          className="size-[9px] rounded-full"
          style={{ background: "#e8d6b0" }}
        />
        <span
          className="size-[9px] rounded-full"
          style={{ background: "#cfd9c4" }}
        />
        <div
          className="flex-1 text-center font-mono text-[10px]"
          style={{ color: "var(--muted-foreground)" }}
        >
          {subdomain}.lacaisse.eu
        </div>
      </div>

      <div className="grid min-h-[360px] [grid-template-columns:140px_1fr]">
        <aside
          className="flex flex-col gap-0.5 border-r p-2.5"
          style={{
            borderColor: "var(--hairline)",
            background: "var(--background)",
          }}
        >
          <div className="mb-2.5 flex items-center gap-2 px-2 py-1.5">
            <span
              className="grid place-items-center rounded-md font-heading text-[13px] font-medium text-white"
              style={{
                width: 22,
                height: 22,
                background: "var(--ap-primary)",
                transition: "background 280ms var(--ease-out)",
              }}
            >
              {initial}
            </span>
            <div
              className="overflow-hidden truncate whitespace-nowrap font-heading text-[13px] text-foreground"
            >
              {fundName || t("yourFund")}
            </div>
          </div>
          {sidebarItems.map((it) => (
            <div
              key={it.l}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[11.5px]"
              style={{
                color: it.on
                  ? "var(--ap-primary-deep)"
                  : "var(--muted-foreground)",
                background: it.on ? "var(--ap-primary-tint)" : "transparent",
                fontWeight: it.on ? 500 : 400,
                transition:
                  "background 280ms var(--ease-out), color 280ms var(--ease-out)",
              }}
            >
              <span
                className="rounded-sm"
                style={{
                  width: 4,
                  height: 4,
                  background: it.on ? "var(--ap-primary)" : "var(--border)",
                  transition: "background 280ms var(--ease-out)",
                }}
              />
              {it.l}
            </div>
          ))}
        </aside>

        <main className="flex flex-col gap-3.5 p-[18px]">
          <div className="flex items-baseline justify-between">
            <div>
              <div
                className="lp-eyebrow whitespace-nowrap"
                style={{ fontSize: 9 }}
              >
                {t("date")}
              </div>
              <h4
                className="mt-0.5 font-heading text-foreground"
                style={{ fontSize: 18, margin: "2px 0 0" }}
              >
                {t("nav.overview")}
              </h4>
            </div>
            <div
              className="inline-flex h-6 items-center gap-1 whitespace-nowrap rounded-md px-2.5 text-[10.5px] font-medium text-primary-foreground"
              style={{
                background: "var(--ap-primary)",
                transition: "background 280ms var(--ease-out)",
              }}
            >
              <span style={{ fontSize: 12, lineHeight: 1 }}>+</span>{" "}
              {t("allocateButton")}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-2">
            {kpis.map((k) => (
              <div
                key={k.label}
                className="rounded-[10px] border p-2.5"
                style={{
                  borderColor: "var(--hairline)",
                  background: "var(--card)",
                }}
              >
                <div
                  className="mb-1 text-[10px]"
                  style={{ color: "var(--muted-foreground)" }}
                >
                  {k.label}
                </div>
                <div
                  className={k.num ? "display-num" : "font-heading"}
                  style={{
                    fontSize: 22,
                    lineHeight: 1.1,
                    color: "var(--foreground)",
                  }}
                >
                  {k.value}
                </div>
                <div
                  className="mt-1"
                  style={{
                    fontSize: 9.5,
                    color: k.positive
                      ? "oklch(0.55 0.13 145)"
                      : "var(--muted-foreground)",
                  }}
                >
                  {k.delta}
                </div>
              </div>
            ))}
          </div>

          <div
            className="rounded-[10px] border p-3"
            style={{
              borderColor: "var(--hairline)",
              background: "var(--card)",
            }}
          >
            <div className="mb-2.5 flex items-center justify-between">
              <div className="text-[10.5px] font-medium">
                {t("chart.title")}
              </div>
              <div
                className="flex gap-2.5 text-[9.5px]"
                style={{ color: "var(--muted-foreground)" }}
              >
                <span className="flex items-center gap-1">
                  <i
                    className="h-0.5 w-2"
                    style={{
                      background: "var(--ap-primary)",
                      transition: "background 280ms var(--ease-out)",
                    }}
                  />{" "}
                  {t("chart.allocated")}
                </span>
                <span className="flex items-center gap-1">
                  <i
                    className="h-0.5 w-2"
                    style={{ background: "var(--border)" }}
                  />{" "}
                  {t("chart.redeemed")}
                </span>
              </div>
            </div>
            <svg
              viewBox="0 0 280 80"
              className="block h-20 w-full"
            >
              <defs>
                <linearGradient id="lp-ap-fill" x1="0" x2="0" y1="0" y2="1">
                  <stop
                    offset="0%"
                    stopColor="var(--ap-primary)"
                    stopOpacity="0.22"
                  />
                  <stop
                    offset="100%"
                    stopColor="var(--ap-primary)"
                    stopOpacity="0"
                  />
                </linearGradient>
              </defs>
              {[20, 40, 60].map((y) => (
                <line
                  key={y}
                  x1="0"
                  x2="280"
                  y1={y}
                  y2={y}
                  stroke="var(--hairline)"
                  strokeWidth="1"
                />
              ))}
              <path
                d="M0 60 L40 50 L80 55 L120 40 L160 28 L200 32 L240 18 L280 22 L280 80 L0 80 Z"
                fill="url(#lp-ap-fill)"
              />
              <path
                d="M0 60 L40 50 L80 55 L120 40 L160 28 L200 32 L240 18 L280 22"
                fill="none"
                stroke="var(--ap-primary)"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M0 68 L40 64 L80 60 L120 55 L160 48 L200 50 L240 42 L280 44"
                fill="none"
                stroke="var(--border)"
                strokeWidth="1.2"
                strokeDasharray="3 3"
                strokeLinecap="round"
              />
            </svg>
          </div>

          <div
            className="overflow-hidden rounded-[10px] border"
            style={{
              borderColor: "var(--hairline)",
              background: "var(--card)",
            }}
          >
            <div
              className="border-b px-3 py-2 text-[10.5px] font-medium"
              style={{ borderColor: "var(--hairline)" }}
            >
              {t("activity.title")}
            </div>
            {[
              {
                who: "Amélie D.",
                what: (
                  <>
                    {t("activity.received", { amount: 50 })} <Token color={color} tokenName={tokenName} />
                  </>
                ),
                when: "12m",
              },
              {
                who: "Boulangerie Pain & Cie",
                what: t("activity.redeemed", { amount: 28 }),
                when: "1h",
              },
              { who: "Karim B.", what: t("activity.joined"), when: "3h" },
            ].map((r, i) => (
              <div
                key={i}
                className="flex items-center justify-between px-3 py-2 text-[11px]"
                style={{
                  borderTop:
                    i === 0 ? undefined : "1px solid var(--hairline)",
                }}
              >
                <div className="flex items-center gap-2">
                  <span
                    className="grid size-[18px] place-items-center rounded-full text-[9px]"
                    style={{
                      background: "var(--muted)",
                      color: "var(--muted-foreground)",
                    }}
                  >
                    {r.who.charAt(0)}
                  </span>
                  <div>
                    <span className="text-foreground">{r.who}</span>
                    <span style={{ color: "var(--muted-foreground)" }}>
                      {" · "}
                      {r.what}
                    </span>
                  </div>
                </div>
                <span
                  className="font-mono text-[10px]"
                  style={{ color: "var(--muted-foreground)" }}
                >
                  {r.when}
                </span>
              </div>
            ))}
          </div>
        </main>
      </div>
    </div>
  );
}

function Token({ color, tokenName }: { color: Swatch; tokenName: string }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-1.5 py-px font-mono text-[10px] font-medium"
      style={{
        background: `oklch(0.58 0.13 ${color.hue} / 0.10)`,
        color: `oklch(0.42 0.12 ${color.hue})`,
        transition:
          "background 280ms var(--ease-out), color 280ms var(--ease-out)",
      }}
    >
      <span
        className="rounded-sm"
        style={{
          width: 4,
          height: 4,
          background: color.oklch,
          transition: "background 280ms var(--ease-out)",
        }}
      />
      {tokenName || "token"}
    </span>
  );
}
