// SPDX-License-Identifier: AGPL-3.0-or-later
import { getTranslations } from "next-intl/server";
import Image from "next/image";
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
import { Button, buttonVariants } from "@/components/ui/button";
import { getCurrentUser } from "@/services/auth/dal";
import { prisma } from "@/services/db/prisma";
import { getApexUrl, getFundUrl } from "@/services/fund/server";
import { getHostType } from "@/services/host/server";
import { LandingPage } from "./_landing/landing-page";
import { PasskeySuggestion } from "./passkey-suggestion";

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ welcome?: string }>;
}) {
  const hostType = await getHostType();

  // Auth host has no top-level page of its own — `/` exists only so post-
  // login redirects to "/" don't 404 here. Signed-in users go to the apex;
  // anonymous to /login. The apex-scoped session cookie travels with them.
  if (hostType === "auth") {
    const user = await getCurrentUser();
    if (!user) redirect("/login");
    redirect(getApexUrl("/"));
  }

  // On a fund's domain (e.g. acme.lacaisse.eu) — drop the user on the admin
  // dashboard. The (fund) layout handles auth and the host check from there.
  if (hostType === "fund") {
    redirect("/dashboard");
  }

  // Apex (lacaisse.eu) — anonymous visitors see the marketing landing.
  // Signed-in users see their fund picker (with new-fund CTA).
  const user = await getCurrentUser();
  if (!user) return <LandingPage />;

  const t = await getTranslations("funds.yourFunds");
  const tCommon = await getTranslations("common");
  const tAccount = await getTranslations("account");
  const memberships = await prisma.fundMember.findMany({
    where: { userId: user.id },
    include: { fund: true },
    orderBy: { fund: { name: "asc" } },
  });

  // Right after sign-up the user is sent here with `?welcome=passkey`. Offer a
  // one-tap passkey setup, but only if they don't already have one (e.g. a
  // refresh, or they registered on a previous visit).
  const { welcome } = await searchParams;
  const suggestPasskey =
    welcome === "passkey" &&
    (await prisma.passkey.count({ where: { userId: user.id } })) === 0;

  return (
    <div className="flex flex-1 items-start justify-center bg-muted/40 px-4 py-12">
      <div className="w-full max-w-2xl space-y-6">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <Image
              src="/logo.png"
              alt="La caisse"
              width={64}
              height={50}
              priority
              className="h-auto w-12"
            />
            <div>
              <h1 className="text-3xl font-semibold tracking-tight">
                {t("title")}
              </h1>
              <p className="text-muted-foreground">{t("description")}</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Link
              href="/account/security"
              className={buttonVariants({ variant: "ghost", size: "sm" })}
            >
              {tAccount("title")}
            </Link>
            {/* /auth/logout clears the Better Auth session — a single cookie
                clear that spans every subdomain. POST so a navigation prefetch
                never accidentally signs the user out. */}
            <form action="/auth/logout" method="post">
              <Button type="submit" variant="ghost" size="sm">
                {tCommon("signOut")}
              </Button>
            </form>
          </div>
        </div>

        {suggestPasskey && <PasskeySuggestion />}

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
