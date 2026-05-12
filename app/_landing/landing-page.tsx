import { getTranslations } from "next-intl/server";
import { getAuthUrl } from "@/services/host/server";
import { LandingNav } from "./landing-nav";
import { LandingFooter } from "./landing-footer";
import { LandingHero } from "./landing-hero";
import { LandingHowItWorks } from "./landing-how-it-works";
import { LandingMultiTenant } from "./landing-multi-tenant";
import { LandingFeatures } from "./landing-features";
import { LandingGetStarted } from "./landing-get-started";
import { SectionDivider } from "./landing-section-divider";

export async function LandingPage() {
  const t = await getTranslations("landing.nav");
  const loginUrl = getAuthUrl("/login");

  return (
    <>
      <LandingNav />
      <main className="flex-1">
        <LandingHero loginUrl={loginUrl} />

        <SectionDivider id="how-it-works" label={t("howItWorks")} />
        <LandingHowItWorks />

        <SectionDivider id="multi-tenant" label={t("multiTenant")} />
        <LandingMultiTenant />

        <SectionDivider id="features" label={t("features")} />
        <LandingFeatures />

        <SectionDivider id="get-started" label={t("getStarted")} />
        <LandingGetStarted />
      </main>
      <LandingFooter />
    </>
  );
}
