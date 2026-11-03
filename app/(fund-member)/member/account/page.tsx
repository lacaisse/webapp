// SPDX-License-Identifier: AGPL-3.0-or-later
import { ExternalLink } from "lucide-react";
import { getTranslations } from "next-intl/server";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { ChangePasswordCard } from "@/app/(apex)/account/security/change-password-card";
import { PasskeysManager } from "@/app/(apex)/account/security/passkeys-manager";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { getCurrentMember } from "@/services/auth/dal";
import { WALLET_URL } from "@/services/auth/oauth-provider-config";
import { prisma } from "@/services/db/prisma";
import { FUND_APEX, getApexUrl, getFundUrl } from "@/services/fund/host";
import { isServerActionRequest } from "@/services/host/server";
import { RemoveLoginCard } from "./remove-login-card";
import { VerificationCard } from "./verification-card";

// The member's account at this fund: who they are, whether their login is
// verified (cards attach only then), password, passkeys, "remove my login",
// sign out. Deliberately no card data — the wallet shows the cards (D5).

export default async function MemberAccountPage() {
  // Same gate as requireMember(), minus its redirects while an action
  // re-renders this page ("remove my login" just signed the user out — the
  // card navigates to /login itself; see services/host/server.ts).
  const { user, fund, member } = await getCurrentMember();
  if (!user || !member) {
    if (await isServerActionRequest()) return null;
    const h = await headers();
    if (!user) {
      redirect(
        `/login?return_to=${encodeURIComponent(`${h.get("x-pathname") ?? "/account"}${h.get("x-search") ?? ""}`)}`,
      );
    }
    redirect("/login?notice=no_membership");
  }
  const t = await getTranslations("memberLogin.account");
  const verified = Boolean(member.emailVerifiedAt && user.emailVerified);
  // Passkeys validate under the apex only (rpID): a fund on its own
  // `<sub>.<apex>` host registers them here, a custom-domain fund on the
  // apex account page.
  const passkeysHere = fund.domain.endsWith(`.${FUND_APEX}`);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("description", { fundName: fund.name })}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4 text-sm">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
            <dt className="text-muted-foreground">{t("identity.name")}</dt>
            <dd>
              {member.firstName} {member.lastName}
            </dd>
            <dt className="text-muted-foreground">{t("identity.email")}</dt>
            <dd className="break-all">{member.email}</dd>
          </dl>
          <VerificationCard verified={verified} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("cards.title")}</CardTitle>
          <CardDescription>{t("cards.description", { fundName: fund.name })}</CardDescription>
        </CardHeader>
        <CardContent>
          <a
            href={WALLET_URL}
            target="_blank"
            rel="noreferrer"
            className={buttonVariants({ variant: "outline" })}
          >
            <ExternalLink className="size-4" />
            {t("cards.open")}
          </a>
        </CardContent>
      </Card>

      <ChangePasswordCard />

      {passkeysHere ? (
        <Suspense fallback={<Skeleton className="h-40 w-full" />}>
          <PasskeysCard userId={user.id} />
        </Suspense>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>{t("passkeys.title")}</CardTitle>
            <CardDescription>{t("passkeys.customDomainNote")}</CardDescription>
          </CardHeader>
          <CardContent>
            <a
              href={getApexUrl("/account/security")}
              className={buttonVariants({ variant: "outline" })}
            >
              {t("passkeys.manageOnApex")}
            </a>
          </CardContent>
        </Card>
      )}

      <RemoveLoginCard />

      <form
        action={`/auth/logout?return_to=${encodeURIComponent(`${getFundUrl(fund.domain)}/login`)}`}
        method="post"
        className="flex justify-end"
      >
        <Button type="submit" variant="ghost">
          {t("signOut")}
        </Button>
      </form>
    </div>
  );
}

async function PasskeysCard({ userId }: { userId: string }) {
  const t = await getTranslations("memberLogin.account.passkeys");
  const passkeys = await prisma.passkey.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    select: { id: true, name: true, deviceType: true, backedUp: true, createdAt: true },
  });
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <PasskeysManager
          passkeys={passkeys.map((p) => ({ ...p, createdAt: p.createdAt.toISOString() }))}
        />
      </CardContent>
    </Card>
  );
}
