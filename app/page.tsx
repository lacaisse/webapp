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
import { getCurrentUser, requireUser } from "@/services/auth/dal";
import { buildLoginRedirect } from "@/services/auth/post-login";
import { prisma } from "@/services/db/prisma";
import { getApexUrl, getFundUrl } from "@/services/fund/server";
import { getHostType } from "@/services/host/server";

export default async function HomePage() {
  const hostType = await getHostType();

  // Auth host has no top-level page of its own — `/` exists only so post-
  // login redirects to "/" don't 404 here. If the user is signed in, hand
  // them off to the apex; otherwise send them to /login.
  if (hostType === "auth") {
    const user = await getCurrentUser();
    if (!user?.email) redirect("/login");
    const { url } = await buildLoginRedirect({
      userId: user.id,
      email: user.email,
      returnTo: getApexUrl("/"),
    });
    redirect(url);
  }

  // On a fund's domain (e.g. acme.lacaisse.eu) — drop the user on the admin
  // dashboard. The (fund) layout handles auth and the host check from there.
  if (hostType === "fund") {
    redirect("/dashboard");
  }

  // Apex (lacaisse.eu) — show the user's funds. `requireUser` handles the
  // sign-in bounce to `auth.<APP_DOMAIN>/login?return_to=…`.
  const user = await requireUser();

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
