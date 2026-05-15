// SPDX-License-Identifier: AGPL-3.0-or-later
import { getTranslations } from "next-intl/server";

const YOURS_KEYS = [
  "customDomain",
  "logoAndColor",
  "tokenName",
  "registrationForm",
  "terms",
  "allocationRules",
  "language",
  "merchantFees",
] as const;

const SHARED_KEYS = [
  "coreMechanics",
  "pageStructure",
  "typography",
  "security",
  "paymentIntegration",
] as const;

export async function LandingMultiTenant() {
  const t = await getTranslations("landing.multiTenant");

  const yours = YOURS_KEYS.map((k) => ({
    title: t(`yours.items.${k}.title`),
    body: t(`yours.items.${k}.body`),
  }));
  const shared = SHARED_KEYS.map((k) => ({
    title: t(`shared.items.${k}.title`),
    body: t(`shared.items.${k}.body`),
  }));

  return (
    <section className="pb-24 pt-4">
      <div className="mx-auto w-full max-w-[1240px] px-8 max-[760px]:px-5">
        <div className="mb-14 grid items-end gap-14 [grid-template-columns:1.1fr_1fr] max-[860px]:grid-cols-1">
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
            {t("title")}
            <span style={{ color: "var(--muted-foreground)" }}>
              {t("titleQualifier")}
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

        <div
          className="grid gap-px overflow-hidden rounded-xl border [grid-template-columns:repeat(auto-fit,minmax(320px,1fr))]"
          style={{
            background: "var(--border)",
            borderColor: "var(--border)",
          }}
        >
          <Column
            kicker={t("yours.kicker")}
            heading={t("yours.heading")}
            description={t("yours.description")}
            items={yours}
            background="var(--card)"
            dotFilled
          />
          <Column
            kicker={t("shared.kicker")}
            heading={t("shared.heading")}
            description={t("shared.description")}
            items={shared}
            background="var(--muted)"
            dotFilled={false}
          />
        </div>

        <HostedFooter />
      </div>
    </section>
  );
}

function Column({
  kicker,
  heading,
  description,
  items,
  background,
  dotFilled,
}: {
  kicker: string;
  heading: string;
  description: string;
  items: { title: string; body: string }[];
  background: string;
  dotFilled: boolean;
}) {
  return (
    <div className="px-8 pb-7 pt-8" style={{ background }}>
      <div
        className="mb-4 flex items-center gap-2.5 text-[11px]"
        style={{ color: "var(--muted-foreground)" }}
      >
        <span
          className="size-1.5 rounded-full"
          style={{
            background: dotFilled ? "var(--primary)" : "transparent",
            border: dotFilled
              ? "none"
              : "1px solid var(--muted-foreground)",
          }}
        />
        <span className="font-mono" style={{ letterSpacing: "0.08em" }}>
          {kicker}
        </span>
      </div>
      <h3
        className="m-0 font-heading text-foreground"
        style={{
          fontSize: 26,
          lineHeight: 1.1,
          fontWeight: 400,
          letterSpacing: "-0.01em",
          fontVariationSettings: '"opsz" 56, "SOFT" 50',
        }}
      >
        {heading}
      </h3>
      <p
        className="mb-2 mt-2.5 leading-relaxed"
        style={{
          fontSize: 14.5,
          color: "var(--muted-foreground)",
          textWrap: "pretty",
        }}
      >
        {description}
      </p>
      <div>
        {items.map((it) => (
          <div
            key={it.title}
            className="grid items-baseline gap-3.5 border-t py-4 [grid-template-columns:14px_1fr]"
            style={{ borderColor: "var(--border)" }}
          >
            <span
              className="size-1.5 rounded-full"
              style={{
                marginTop: 8,
                background: dotFilled ? "var(--primary)" : "transparent",
                border: dotFilled
                  ? "none"
                  : "1px solid var(--muted-foreground)",
              }}
            />
            <div>
              <h4
                className="m-0 text-[15px] font-medium text-foreground"
                style={{ lineHeight: 1.35, letterSpacing: "-0.005em" }}
              >
                {it.title}
              </h4>
              <p
                className="m-0 mt-1.5"
                style={{
                  fontSize: 13.5,
                  lineHeight: 1.55,
                  color: "var(--muted-foreground)",
                  textWrap: "pretty",
                }}
              >
                {it.body}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

async function HostedFooter() {
  const t = await getTranslations("landing.multiTenant.hosting");

  return (
    <div
      className="mt-8 rounded-xl border px-10 pb-9 pt-10 max-[760px]:px-6"
      style={{
        background: "var(--card)",
        borderColor: "var(--border)",
      }}
    >
      <div className="mb-8 grid items-end gap-8 [grid-template-columns:1fr_auto] max-[640px]:grid-cols-1">
        <div>
          <div className="mb-2.5 flex items-center gap-2.5">
            <span className="lp-dot" />
            <span className="lp-eyebrow">{t("eyebrow")}</span>
          </div>
          <h3
            className="m-0 font-heading text-foreground"
            style={{
              fontSize: 32,
              lineHeight: 1.05,
              fontWeight: 400,
              letterSpacing: "-0.01em",
              fontVariationSettings: '"opsz" 72, "SOFT" 50',
              textWrap: "balance",
            }}
          >
            {t("title")}
          </h3>
          <p
            className="m-0 mt-2 max-w-[480px] text-[15.5px]"
            style={{ color: "var(--muted-foreground)" }}
          >
            {t("subtitle")}
          </p>
        </div>
      </div>

      <div
        className="grid gap-px overflow-hidden rounded-lg border [grid-template-columns:repeat(auto-fit,minmax(280px,1fr))]"
        style={{
          background: "var(--border)",
          borderColor: "var(--border)",
        }}
      >
        <HostedCard
          step={t("path1.step")}
          label={t("path1.label")}
          title={t("path1.title")}
          body={t("path1.body")}
          background="var(--card)"
        />
        <HostedCard
          step={t("path2.step")}
          label={t("path2.label")}
          title={t("path2.title")}
          body={t("path2.body")}
          background="var(--muted)"
        />
      </div>
    </div>
  );
}

function HostedCard({
  step,
  label,
  title,
  body,
  background,
}: {
  step: string;
  label: string;
  title: string;
  body: string;
  background: string;
}) {
  return (
    <article
      className="flex flex-col gap-3 px-6 pb-5 pt-6"
      style={{ background }}
    >
      <div
        className="flex items-center gap-2.5 text-[11px]"
        style={{ color: "var(--muted-foreground)" }}
      >
        <span
          className="font-mono whitespace-nowrap"
          style={{ letterSpacing: "0.08em" }}
        >
          {step}
        </span>
        <span
          className="h-px w-4 shrink-0"
          style={{ background: "var(--border)" }}
        />
        <span
          className="font-mono whitespace-nowrap"
          style={{ letterSpacing: "0.08em" }}
        >
          {label}
        </span>
      </div>
      <h4
        className="m-0 font-heading text-foreground"
        style={{
          fontSize: 22,
          lineHeight: 1.15,
          fontWeight: 400,
          letterSpacing: "-0.005em",
          fontVariationSettings: '"opsz" 48, "SOFT" 50',
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
