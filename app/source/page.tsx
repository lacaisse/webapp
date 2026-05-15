// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Metadata } from "next";
import Link from "next/link";
import { CodeXml } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { buttonVariants } from "@/components/ui/button";

export const dynamic = "force-static";

const REPO_URL = "https://github.com/lacaisse/webapp";

function getCommitSha(): string | null {
  return (
    process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA ?? null
  );
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("source");
  return { title: t("title") };
}

export default async function SourcePage() {
  const t = await getTranslations("source");
  const tCommon = await getTranslations("common");

  const sha = getCommitSha();
  const shortSha = sha?.slice(0, 7);
  const commitUrl = sha ? `${REPO_URL}/tree/${sha}` : REPO_URL;

  return (
    <div className="flex flex-1 flex-col items-center bg-muted/40 px-4 py-12">
      <div className="w-full max-w-2xl space-y-8">
        <header className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">
            {t("title")}
          </h1>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t("intro")}
          </p>
        </header>

        <dl className="divide-y divide-border rounded-xl bg-card ring-1 ring-foreground/10">
          <div className="grid grid-cols-[140px_1fr] gap-4 px-4 py-3 text-sm max-[520px]:grid-cols-1 max-[520px]:gap-1">
            <dt className="text-muted-foreground">{t("repository")}</dt>
            <dd>
              <a
                href={REPO_URL}
                target="_blank"
                rel="noreferrer"
                className="font-mono underline underline-offset-2 hover:text-foreground"
              >
                {REPO_URL}
              </a>
            </dd>
          </div>

          <div className="grid grid-cols-[140px_1fr] gap-4 px-4 py-3 text-sm max-[520px]:grid-cols-1 max-[520px]:gap-1">
            <dt className="text-muted-foreground">{t("commit")}</dt>
            <dd>
              {sha ? (
                <a
                  href={commitUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono underline underline-offset-2 hover:text-foreground"
                >
                  {shortSha}
                </a>
              ) : (
                <span className="text-muted-foreground">
                  {t("commitMissing")}
                </span>
              )}
            </dd>
          </div>

          <div className="grid grid-cols-[140px_1fr] gap-4 px-4 py-3 text-sm max-[520px]:grid-cols-1 max-[520px]:gap-1">
            <dt className="text-muted-foreground">{t("license")}</dt>
            <dd>{t("licenseValue")}</dd>
          </div>

          <div className="grid grid-cols-[140px_1fr] gap-4 px-4 py-3 text-sm max-[520px]:grid-cols-1 max-[520px]:gap-1">
            <dt className="text-muted-foreground">{t("thirdParty")}</dt>
            <dd>
              <Link
                href="/licenses"
                className="underline underline-offset-2 hover:text-foreground"
              >
                {t("thirdPartyLink")}
              </Link>
            </dd>
          </div>
        </dl>

        <div className="flex flex-wrap gap-3">
          <a
            href={commitUrl}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ variant: "default" })}
          >
            <CodeXml className="size-4" />
            {t("viewOnGithub")}
          </a>
          <Link href="/" className={buttonVariants({ variant: "outline" })}>
            {tCommon("backToHome")}
          </Link>
        </div>
      </div>
    </div>
  );
}
