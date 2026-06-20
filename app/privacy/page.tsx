// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { buttonVariants } from "@/components/ui/button";
import { PolicySection } from "../_policy/section";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("privacy");
  return { title: t("title") };
}

export default async function PrivacyPage() {
  const t = await getTranslations("privacy");
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
          heading={t("controller.heading")}
          body={t("controller.body")}
        />

        <PolicySection
          heading={t("scope.heading")}
          intro={t("scope.intro")}
          items={t.raw("scope.items") as string[]}
          note={t("scope.note")}
        />

        <PolicySection
          heading={t("data.heading")}
          intro={t("data.intro")}
          items={t.raw("data.items") as string[]}
          note={t("data.note")}
        />

        <PolicySection
          heading={t("subprocessors.heading")}
          intro={t("subprocessors.intro")}
          items={t.raw("subprocessors.items") as string[]}
          note={t("subprocessors.note")}
        />

        <PolicySection
          heading={t("retention.heading")}
          items={t.raw("retention.items") as string[]}
        />

        <PolicySection
          heading={t("rights.heading")}
          intro={t("rights.intro")}
          items={t.raw("rights.items") as string[]}
          contact={t("rights.contact")}
        />

        <PolicySection
          heading={t("cookies.heading")}
          body={t("cookies.body")}
        />

        <PolicySection
          heading={t("security.heading")}
          body={t("security.body")}
        />

        <PolicySection
          heading={t("changes.heading")}
          body={t("changes.body")}
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
