// SPDX-License-Identifier: AGPL-3.0-or-later
import { getTranslations } from "next-intl/server";
import { getAuthUrl } from "@/services/host/server";

export async function LandingGetStarted() {
  const t = await getTranslations("landing.getStarted");
  const signupUrl = getAuthUrl("/signup");

  return (
    <section className="px-8 pb-6 pt-2 max-[760px]:px-5">
      <div className="mx-auto w-full max-w-[1240px]">
        <div className="grid items-stretch gap-6 [grid-template-columns:1fr_1fr] max-[760px]:grid-cols-1">
          <div
            className="flex min-h-[280px] flex-col justify-between gap-8 rounded-xl p-12 max-[760px]:p-8"
            style={{
              background: "var(--card)",
              boxShadow: "0 0 0 1px var(--hairline)",
            }}
          >
            <div>
              <div className="mb-3.5 flex items-center gap-2.5">
                <span className="lp-dot lp-dot-pulse" />
                <span className="lp-eyebrow">{t("left.eyebrow")}</span>
              </div>
              <h3
                className="m-0 font-heading text-foreground"
                style={{
                  fontSize: 36,
                  lineHeight: 1.05,
                  fontWeight: 400,
                  letterSpacing: "-0.01em",
                  textWrap: "balance",
                }}
              >
                {t("left.title")}
              </h3>
              <p
                className="mt-3.5 max-w-[460px] text-base leading-relaxed"
                style={{ color: "var(--muted-foreground)" }}
              >
                {t("left.body")}
              </p>
            </div>
            <div className="flex gap-2.5 max-[420px]:flex-col">
              <a
                href={signupUrl}
                className="inline-flex h-11 items-center gap-2 rounded-lg px-[18px] text-[15px] font-medium text-primary-foreground no-underline transition-opacity hover:opacity-90"
                style={{ background: "var(--primary)" }}
              >
                {t("left.ctaPrimary")} →
              </a>
            </div>
          </div>

          <div
            className="flex min-h-[280px] flex-col justify-between gap-8 rounded-xl p-12 max-[760px]:p-8"
            style={{
              background: "var(--muted)",
              boxShadow: "0 0 0 1px var(--hairline)",
            }}
          >
            <div>
              <div className="mb-3.5 flex items-center gap-2.5">
                <span className="lp-dot" />
                <span className="lp-eyebrow">{t("right.eyebrow")}</span>
              </div>
              <h3
                className="m-0 font-heading text-foreground"
                style={{
                  fontSize: 36,
                  lineHeight: 1.05,
                  fontWeight: 400,
                  letterSpacing: "-0.01em",
                  textWrap: "balance",
                }}
              >
                {t("right.title")}
              </h3>
              <p
                className="mt-3.5 max-w-[460px] text-base leading-relaxed"
                style={{ color: "var(--muted-foreground)" }}
              >
                {t("right.body")}
              </p>
            </div>
            <div
              className="flex items-center gap-2.5 rounded-md border px-3.5 py-3 font-mono text-foreground"
              style={{
                background: "var(--card)",
                borderColor: "var(--border)",
                fontSize: 13,
              }}
            >
              <span style={{ color: "var(--muted-foreground)" }}>$</span>
              docker run --rm lacaisse/server:latest
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
