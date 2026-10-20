// SPDX-License-Identifier: AGPL-3.0-or-later
import { getTranslations } from "next-intl/server";
import { headers } from "next/headers";
import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";

// The pay page 404s when the serial in the URL is not a card of this fund or
// has no member yet. The app-wide not-found page would then say "this fund
// doesn't exist", which is wrong (the fund resolved fine) and sends the
// member chasing the wrong thing — a card from another fund on the shared
// Citizen Pay card instance lands here, for instance. Say what is missing.
export default async function CardNotFound() {
  const t = await getTranslations("cotisation.cardNotFound");
  const tCommon = await getTranslations("common");
  const serial = (await headers()).get("x-pathname")?.split("/").pop() ?? "";

  return (
    <div className="flex flex-1 items-center justify-center bg-muted/40 px-4 py-12">
      <div className="w-full max-w-md space-y-6 text-center">
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
          <p className="text-muted-foreground">
            {t.rich("description", {
              serial,
              code: (chunks) => <code className="font-mono">{chunks}</code>,
            })}
          </p>
        </div>
        <Link href="/" className={buttonVariants({ variant: "outline" })}>
          {tCommon("backToHome")}
        </Link>
      </div>
    </div>
  );
}
