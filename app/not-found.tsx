// SPDX-License-Identifier: AGPL-3.0-or-later
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { headers } from "next/headers";
import { buttonVariants } from "@/components/ui/button";

export default async function NotFound() {
  const h = await headers();
  // Show the fund-specific message only when the user landed on a host that
  // looks like one of ours but doesn't have a Fund row. Without a host
  // the request is effectively on the apex.
  const host = h.get("host")?.split(":")[0];
  const baseDomain = process.env.APP_DOMAIN ?? "localhost";
  const isFundLikeHost =
    !!host && host !== baseDomain && host !== `www.${baseDomain}`;
  const t = await getTranslations();

  return (
    <div className="flex flex-1 items-center justify-center bg-muted/40 px-4 py-12">
      <div className="w-full max-w-md text-center space-y-6">
        {isFundLikeHost ? (
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              {t("funds.notFound.title")}
            </h1>
            <p className="text-muted-foreground">
              {t.rich("funds.notFound.description", {
                domain: host,
                code: (chunks) => <code className="font-mono">{chunks}</code>,
              })}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              {t("errors.notFoundTitle")}
            </h1>
            <p className="text-muted-foreground">
              {t("errors.notFoundDescription")}
            </p>
          </div>
        )}
        <Link href="/" className={buttonVariants({ variant: "outline" })}>
          {t("common.backToHome")}
        </Link>
      </div>
    </div>
  );
}
