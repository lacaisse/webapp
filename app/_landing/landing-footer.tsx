import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { LandingLogo } from "./landing-logo";

export async function LandingFooter() {
  const t = await getTranslations("landing.footer");

  const columns: Array<{ heading: string; items: string[] }> = [
    {
      heading: t("product.heading"),
      items: [
        t("product.howItWorks"),
        t("product.features"),
        t("product.changelog"),
      ],
    },
    {
      heading: t("resources.heading"),
      items: [
        t("resources.documentation"),
        t("resources.github"),
        t("resources.brand"),
        t("resources.status"),
      ],
    },
    {
      heading: t("organization.heading"),
      items: [
        t("organization.about"),
        t("organization.contact"),
        t("organization.privacy"),
        t("organization.terms"),
      ],
    },
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
        <div className="grid gap-10 max-[860px]:grid-cols-2 max-[520px]:grid-cols-1 [grid-template-columns:2fr_1fr_1fr_1fr]">
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
          {columns.map((col) => (
            <div key={col.heading}>
              <div className="lp-eyebrow mb-3.5">{col.heading}</div>
              <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
                {col.items.map((it) => (
                  <li key={it}>
                    <a
                      href="#"
                      className="text-sm text-foreground no-underline hover:underline"
                    >
                      {it}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
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
            <Link href="/licenses" className="no-underline hover:underline">
              {t("licensesLink")}
            </Link>
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
