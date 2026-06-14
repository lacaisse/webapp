// SPDX-License-Identifier: AGPL-3.0-or-later
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { getAuthUrl } from "@/services/host/server";
import { LandingLogo } from "./landing-logo";

export async function LandingNav() {
  const t = await getTranslations("landing.nav");
  const loginUrl = getAuthUrl("/login");

  const items = [
    { label: t("howItWorks"), href: "#how-it-works" },
    { label: t("multiTenant"), href: "#multi-tenant" },
    { label: t("features"), href: "#features" },
    { label: t("getStarted"), href: "#get-started" },
  ];

  return (
    <nav
      className="sticky top-0 z-50 border-b"
      style={{
        background: "oklch(0.99 0.005 75 / 0.82)",
        backdropFilter: "blur(12px) saturate(160%)",
        WebkitBackdropFilter: "blur(12px) saturate(160%)",
        borderColor: "var(--hairline)",
      }}
    >
      <div className="mx-auto flex h-16 w-full max-w-[1240px] items-center justify-between px-8 max-[760px]:px-5">
        <Link
          href="/"
          className="flex items-center gap-2.5 text-foreground no-underline"
        >
          <LandingLogo size={26} animated />
          <span
            className="font-heading"
            style={{ fontSize: 19, letterSpacing: "-0.005em" }}
          >
            la caisse
          </span>
        </Link>
        <div className="flex items-center gap-1 max-[860px]:hidden">
          {items.map(({ label, href }) => (
            <a
              key={label}
              href={href}
              className="rounded-md px-3 py-2 text-sm text-foreground no-underline transition-colors hover:bg-muted"
            >
              {label}
            </a>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <a
            href={loginUrl}
            className="rounded-md px-3 py-2 text-sm text-foreground no-underline transition-colors hover:bg-muted"
          >
            {t("signIn")}
          </a>
          <a
            href="#get-started"
            className="inline-flex h-9 items-center rounded-lg px-3.5 text-sm font-medium text-primary-foreground no-underline transition-colors hover:opacity-90"
            style={{ background: "var(--primary)" }}
          >
            {t("joinWaitlist")}
          </a>
        </div>
      </div>
    </nav>
  );
}
