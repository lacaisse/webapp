import { getTranslations } from "next-intl/server";

const GROUPS = [
  {
    key: "members",
    accentFirst: false,
    items: ["accountsCards", "allocations", "balance", "referrals"] as const,
  },
  {
    key: "team",
    accentFirst: true,
    items: [
      "tieredAllocations",
      "memberManagement",
      "reporting",
      "transactionalEmail",
    ] as const,
  },
  {
    key: "merchants",
    accentFirst: false,
    items: ["onboarding", "fees", "payouts"] as const,
  },
] as const;

const CHIPS = [
  "multiTenant",
  "gdprConscious",
  "agplLicense",
  "publicOnGithub",
  "selfHostOrHosted",
  "dataExport",
] as const;

export async function LandingFeatures() {
  const t = await getTranslations("landing.features");

  return (
    <section className="pb-24 pt-4">
      <div className="mx-auto w-full max-w-[1240px] px-8 max-[760px]:px-5">
        <div className="mb-2 grid items-end gap-14 [grid-template-columns:1.1fr_1fr] max-[860px]:grid-cols-1">
          <h2
            className="m-0 font-heading text-foreground"
            style={{
              fontSize: "clamp(40px, 5vw, 64px)",
              lineHeight: 1.02,
              fontWeight: 400,
              fontVariationSettings: '"opsz" 144, "SOFT" 50',
              letterSpacing: "-0.015em",
              textWrap: "balance",
            }}
          >
            {t("titleTop")}
            <br />
            <span style={{ color: "var(--muted-foreground)" }}>
              {t("titleBottom")}
            </span>
          </h2>
          <p
            className="m-0 max-w-[460px] pb-3 text-[17px] leading-relaxed"
            style={{
              color: "var(--muted-foreground)",
              textWrap: "pretty",
            }}
          >
            {t("intro")}
          </p>
        </div>

        <div className="mt-14">
          {GROUPS.map((g, i) => (
            <FeatureGroup
              key={g.key}
              groupKey={g.key}
              index={i + 1}
              accentFirst={g.accentFirst}
              itemKeys={g.items as readonly string[]}
            />
          ))}
        </div>

        <UnderTheHood />
      </div>
    </section>
  );
}

async function FeatureGroup({
  groupKey,
  index,
  accentFirst,
  itemKeys,
}: {
  groupKey: string;
  index: number;
  accentFirst: boolean;
  itemKeys: readonly string[];
}) {
  const t = await getTranslations(`landing.features.groups.${groupKey}`);
  const tLabels = await getTranslations("landing.features");

  const features = itemKeys.map((k) => ({
    kicker: t(`items.${k}.kicker`),
    title: t(`items.${k}.title`),
    body: t(`items.${k}.body`),
  }));

  const cols =
    features.length === 4
      ? "repeat(auto-fit, minmax(220px, 1fr))"
      : "repeat(auto-fit, minmax(240px, 1fr))";

  return (
    <div
      className="grid gap-16 border-t py-12 [grid-template-columns:300px_1fr] max-[860px]:grid-cols-1 max-[860px]:gap-8"
      style={{ borderColor: "var(--border)" }}
    >
      <div className="flex flex-col gap-3.5">
        <div
          className="flex items-center gap-2.5 text-[11px]"
          style={{ color: "var(--muted-foreground)" }}
        >
          <span className="font-mono" style={{ letterSpacing: "0.08em" }}>
            {String(index).padStart(2, "0")}
          </span>
          <span
            className="h-px w-[18px]"
            style={{ background: "var(--border)" }}
          />
          <span className="font-mono" style={{ letterSpacing: "0.08em" }}>
            {tLabels("groupLabel")}
          </span>
        </div>
        <h3
          className="m-0 font-heading text-foreground"
          style={{
            fontSize: 32,
            lineHeight: 1.1,
            fontWeight: 400,
            letterSpacing: "-0.01em",
            textWrap: "balance",
            fontVariationSettings: '"opsz" 72, "SOFT" 50',
          }}
        >
          {t("label")}
        </h3>
        <p
          className="m-0 max-w-[280px] leading-relaxed"
          style={{
            fontSize: 15,
            color: "var(--muted-foreground)",
            textWrap: "pretty",
          }}
        >
          {t("intro")}
        </p>
      </div>

      <div className="grid gap-x-8 gap-y-8" style={{ gridTemplateColumns: cols }}>
        {features.map((f, i) => (
          <FeatureItem
            key={f.kicker}
            kicker={f.kicker}
            title={f.title}
            body={f.body}
            accent={accentFirst && i === 0}
          />
        ))}
      </div>
    </div>
  );
}

function FeatureItem({
  kicker,
  title,
  body,
  accent,
}: {
  kicker: string;
  title: string;
  body: string;
  accent: boolean;
}) {
  return (
    <article className="flex flex-col gap-2.5 pt-1">
      <div
        className="flex items-center gap-2 text-[11px]"
        style={{ color: "var(--muted-foreground)" }}
      >
        <span
          className="rounded-full"
          style={{
            width: 5,
            height: 5,
            background: accent ? "var(--primary)" : "var(--border)",
          }}
        />
        <span className="font-mono" style={{ letterSpacing: "0.06em" }}>
          {kicker.toUpperCase()}
        </span>
      </div>
      <h4
        className="m-0 font-heading text-foreground"
        style={{
          fontSize: 21,
          lineHeight: 1.2,
          fontWeight: 400,
          letterSpacing: "-0.005em",
          textWrap: "balance",
          fontVariationSettings: '"opsz" 36, "SOFT" 50',
        }}
      >
        {title}
      </h4>
      <p
        className="m-0 leading-relaxed"
        style={{
          fontSize: 14,
          color: "var(--muted-foreground)",
          textWrap: "pretty",
        }}
      >
        {body}
      </p>
    </article>
  );
}

async function UnderTheHood() {
  const t = await getTranslations("landing.features.underTheHood");

  return (
    <div
      className="mt-4 grid items-start gap-16 rounded-xl border p-10 [grid-template-columns:300px_1fr] max-[860px]:grid-cols-1 max-[760px]:px-6"
      style={{
        background: "var(--muted)",
        borderColor: "var(--border)",
      }}
    >
      <div className="flex flex-col gap-3.5">
        <div
          className="flex items-center gap-2.5 text-[11px]"
          style={{ color: "var(--muted-foreground)" }}
        >
          <span
            className="size-1.5 rounded-full"
            style={{ background: "var(--primary)" }}
          />
          <span className="font-mono" style={{ letterSpacing: "0.08em" }}>
            {t("kicker")}
          </span>
        </div>
        <h3
          className="m-0 font-heading text-foreground"
          style={{
            fontSize: 28,
            lineHeight: 1.1,
            fontWeight: 400,
            letterSpacing: "-0.01em",
            fontVariationSettings: '"opsz" 72, "SOFT" 50',
            textWrap: "balance",
          }}
        >
          {t("title")}
        </h3>
      </div>
      <div className="flex flex-col gap-4 pt-1">
        <p
          className="m-0 max-w-[640px] text-foreground leading-relaxed"
          style={{ fontSize: 16, textWrap: "pretty" }}
        >
          {t("body")}
        </p>
        <div className="mt-1 flex flex-wrap gap-2">
          {CHIPS.map((chip) => (
            <span
              key={chip}
              className="font-mono rounded-full border px-2.5 py-1.5 text-[11px]"
              style={{
                background: "var(--card)",
                borderColor: "var(--border)",
                color: "var(--muted-foreground)",
                letterSpacing: "0.06em",
              }}
            >
              {t(`chips.${chip}`).toUpperCase()}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}
