import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { buttonVariants } from "@/components/ui/button";
import { PolicySection } from "../_policy/section";

export const dynamic = "force-static";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("terms");
  return { title: t("title") };
}

export default async function TermsPage() {
  const t = await getTranslations("terms");
  const tCommon = await getTranslations("common");

  return (
    <div className="flex flex-1 flex-col items-center bg-muted/40 px-4 py-12">
      <div className="w-full max-w-3xl space-y-8">
        <header className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">
            {t("title")}
          </h1>
          <p className="text-xs uppercase tracking-wide text-muted-foreground">
            {t("lastUpdated")}
          </p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t("intro")}
          </p>
        </header>

        <PolicySection
          heading={t("about.heading")}
          body={t("about.body")}
        />
        <PolicySection
          heading={t("eligibility.heading")}
          body={t("eligibility.body")}
        />
        <PolicySection
          heading={t("account.heading")}
          body={t("account.body")}
        />
        <PolicySection
          heading={t("acceptableUse.heading")}
          intro={t("acceptableUse.intro")}
          items={t.raw("acceptableUse.items") as string[]}
        />
        <PolicySection
          heading={t("billing.heading")}
          items={t.raw("billing.items") as string[]}
        />
        <PolicySection
          heading={t("openSource.heading")}
          body={t("openSource.body")}
        />
        <PolicySection
          heading={t("yourData.heading")}
          body={t("yourData.body")}
        />
        <PolicySection
          heading={t("availability.heading")}
          body={t("availability.body")}
        />
        <PolicySection
          heading={t("disclaimers.heading")}
          body={t("disclaimers.body")}
        />
        <PolicySection
          heading={t("liability.heading")}
          body={t("liability.body")}
        />
        <PolicySection
          heading={t("termination.heading")}
          items={t.raw("termination.items") as string[]}
        />
        <PolicySection
          heading={t("changes.heading")}
          body={t("changes.body")}
        />
        <PolicySection
          heading={t("law.heading")}
          body={t("law.body")}
        />
        <PolicySection
          heading={t("contactSection.heading")}
          body={t("contactSection.body")}
        />

        <div className="pt-4">
          <Link href="/" className={buttonVariants({ variant: "outline" })}>
            {tCommon("backToHome")}
          </Link>
        </div>
      </div>
    </div>
  );
}
