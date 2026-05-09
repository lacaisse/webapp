import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import { Plus } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { buttonVariants } from "@/components/ui/button";
import { getCurrentUser } from "@/services/auth/dal";
import { prisma } from "@/services/db/prisma";
import {
  getCurrentFundDomain,
  getFundUrl,
  requireCurrentFund,
} from "@/services/fund/server";

export default async function HomePage() {
  // On a fund's domain (e.g. acme.lacaisse.eu) — render the fund's dashboard.
  const domain = await getCurrentFundDomain();
  if (domain) {
    const fund = await requireCurrentFund();
    const t = await getTranslations("funds.dashboard");
    return (
      <div className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="text-center space-y-2">
          <h1 className="text-3xl font-semibold tracking-tight">
            {fund.name}
          </h1>
          <p className="text-muted-foreground">{t("comingSoon")}</p>
        </div>
      </div>
    );
  }

  // Apex (lacaisse.eu) — show the user's funds.
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const t = await getTranslations("funds.yourFunds");
  const memberships = await prisma.fundMember.findMany({
    where: { userId: user.id },
    include: { fund: true },
    orderBy: { fund: { name: "asc" } },
  });

  return (
    <div className="flex flex-1 items-start justify-center bg-muted/40 px-4 py-12">
      <div className="w-full max-w-2xl space-y-6">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">
            {t("title")}
          </h1>
          <p className="text-muted-foreground">{t("description")}</p>
        </div>

        {memberships.length === 0 ? (
          <Card>
            <CardHeader>
              <CardTitle>{t("emptyTitle")}</CardTitle>
              <CardDescription>{t("emptyDescription")}</CardDescription>
            </CardHeader>
            <CardContent>
              <Link
                href="/new"
                className={buttonVariants({ variant: "default" })}
              >
                <Plus className="size-4" />
                {t("create")}
              </Link>
            </CardContent>
          </Card>
        ) : (
          <>
            <div className="grid gap-3">
              {memberships.map(({ fund, role }) => (
                <a
                  key={fund.id}
                  href={getFundUrl(fund.domain)}
                  className="block rounded-lg border bg-card p-4 transition-colors hover:bg-muted"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <div className="font-medium">{fund.name}</div>
                      <div className="text-sm text-muted-foreground">
                        {fund.domain}
                      </div>
                    </div>
                    <span className="text-xs uppercase tracking-wide text-muted-foreground">
                      {role}
                    </span>
                  </div>
                </a>
              ))}
            </div>
            <Link
              href="/new"
              className={buttonVariants({ variant: "outline" })}
            >
              <Plus className="size-4" />
              {t("createAnother")}
            </Link>
          </>
        )}
      </div>
    </div>
  );
}
