import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { LandingLogo } from "./landing-logo";

const GITHUB_URL = "https://github.com/lacaisse/webapp";

export async function LandingFooter() {
  const t = await getTranslations("landing.footer");

  const exploreLinks = [
    { label: t("explore.howItWorks"), href: "#how-it-works" },
    { label: t("explore.multiTenant"), href: "#multi-tenant" },
    { label: t("explore.features"), href: "#features" },
    { label: t("explore.getStarted"), href: "#get-started" },
  ];

  return (
    <footer
      className="mt-20 border-t"
      style={{
        background: "var(--muted)",
        borderColor: "var(--border)",
      }}
    >
      <div className="mx-auto w-full max-w-[1240px] px-8 pb-10 pt-14 max-[760px]:px-5">
        <div className="grid gap-10 max-[520px]:grid-cols-1 [grid-template-columns:2fr_1fr]">
          <div>
            <div className="flex items-center gap-2.5">
              <LandingLogo size={28} />
              <span className="font-heading" style={{ fontSize: 20 }}>
                la caisse
              </span>
            </div>
            <p
              className="mt-4 max-w-xs text-sm leading-relaxed"
              style={{ color: "var(--muted-foreground)" }}
            >
              {t("description")}
            </p>
          </div>
          <div>
            <div className="lp-eyebrow mb-3.5">{t("explore.heading")}</div>
            <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
              {exploreLinks.map(({ label, href }) => (
                <li key={href}>
                  <a
                    href={href}
                    className="text-sm text-foreground no-underline hover:underline"
                  >
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        </div>
        <div
          className="mt-12 flex flex-wrap items-center justify-between gap-4 border-t pt-6 text-[13px]"
          style={{
            borderColor: "var(--border)",
            color: "var(--muted-foreground)",
          }}
        >
          <div className="flex flex-wrap items-center gap-2">
            <span>{t("copyright")}</span>
            <span aria-hidden>·</span>
            <Link href="/privacy" className="no-underline hover:underline">
              {t("privacyLink")}
            </Link>
            <span aria-hidden>·</span>
            <Link href="/terms" className="no-underline hover:underline">
              {t("termsLink")}
            </Link>
            <span aria-hidden>·</span>
            <Link href="/licenses" className="no-underline hover:underline">
              {t("licensesLink")}
            </Link>
            <span aria-hidden>·</span>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noreferrer"
              className="no-underline hover:underline"
            >
              {t("githubLink")}
            </a>
          </div>
          <div className="flex items-center gap-4">
            <LocaleSwitcher />
            <span className="font-mono text-xs">lacaisse.eu</span>
          </div>
        </div>
      </div>
    </footer>
  );
}
