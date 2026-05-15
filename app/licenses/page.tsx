// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Metadata } from "next";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { buttonVariants } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import packages from "./data.json";

type LicensePackage = {
  name: string;
  version: string;
  license: string;
  repository: string | null;
  publisher: string | null;
};

export const dynamic = "force-static";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("licenses");
  return { title: t("title") };
}

const AGPL_URL = "https://www.gnu.org/licenses/agpl-3.0.html";

export default async function LicensesPage() {
  const t = await getTranslations("licenses");
  const list = packages as LicensePackage[];

  return (
    <div className="flex flex-1 flex-col items-center bg-muted/40 px-4 py-12">
      <div className="w-full max-w-4xl space-y-6">
        <header className="space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">
            {t("title")}
          </h1>
          <p className="text-muted-foreground">{t("intro")}</p>
          <p className="text-sm text-muted-foreground">
            {t.rich("selfLicense", {
              link: (chunks) => (
                <a
                  href={AGPL_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  {chunks}
                </a>
              ),
            })}
          </p>
        </header>

        <p className="text-xs text-muted-foreground">
          {t("count", { count: list.length })}
        </p>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("table.name")}</TableHead>
              <TableHead>{t("table.version")}</TableHead>
              <TableHead>{t("table.license")}</TableHead>
              <TableHead className="text-right">
                {t("table.source")}
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.map((pkg) => (
              <TableRow key={`${pkg.name}@${pkg.version}`}>
                <TableCell className="font-mono text-sm break-all">
                  {pkg.name}
                </TableCell>
                <TableCell className="font-mono text-xs text-muted-foreground">
                  {pkg.version}
                </TableCell>
                <TableCell className="text-sm">{pkg.license}</TableCell>
                <TableCell className="text-right">
                  {pkg.repository ? (
                    <a
                      href={pkg.repository}
                      target="_blank"
                      rel="noreferrer"
                      className="text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground"
                    >
                      {t("table.viewSource")}
                    </a>
                  ) : (
                    <span className="text-sm text-muted-foreground">—</span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        <div className="pt-4">
          <Link href="/" className={buttonVariants({ variant: "outline" })}>
            {t("backHome")}
          </Link>
        </div>
      </div>
    </div>
  );
}
