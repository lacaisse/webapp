// SPDX-License-Identifier: AGPL-3.0-or-later
import { ArrowLeft } from "lucide-react";
import { getTranslations } from "next-intl/server";
import Link from "next/link";

// Chrome for the platform-admin section (apex host, User.globalRole ADMIN).
// Pages gate themselves with requireAdmin(); this only frames them, like the
// account section does.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations("admin");

  return (
    <div className="flex flex-1 items-start justify-center bg-muted/40 px-4 py-12">
      <div className="w-full max-w-4xl space-y-6">
        <div className="space-y-1">
          <Link
            href="/"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" />
            {t("backToFunds")}
          </Link>
          <h1 className="text-3xl font-semibold tracking-tight">{t("title")}</h1>
        </div>
        {children}
      </div>
    </div>
  );
}
