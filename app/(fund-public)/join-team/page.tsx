// SPDX-License-Identifier: AGPL-3.0-or-later
import { getTranslations } from "next-intl/server";

import { buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getCurrentUser } from "@/services/auth/dal";
import { prisma } from "@/services/db/prisma";
import { getFundUrl, requireCurrentFund } from "@/services/fund/server";
import { getAuthUrl } from "@/services/host/server";
import { AcceptButton } from "./accept-button";

export default async function JoinTeamPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const t = await getTranslations("joinTeam");
  const roleLabel = await getTranslations("team.roles");
  const fund = await requireCurrentFund();
  const { token } = await searchParams;

  const invite = token
    ? await prisma.fundInvite.findFirst({
        where: { fundId: fund.id, token },
        select: { email: true, role: true, expiresAt: true, acceptedAt: true },
      })
    : null;

  // Terminal / error states.
  if (!invite) return <Shell title={t("invalidTitle")} body={t("invalidBody")} />;
  if (invite.acceptedAt)
    return <Shell title={t("acceptedTitle")} body={t("acceptedBody")} />;
  if (invite.expiresAt.getTime() < new Date().getTime())
    return <Shell title={t("expiredTitle")} body={t("expiredBody")} />;

  const user = await getCurrentUser();
  const acceptUrl = `${getFundUrl(fund.domain)}/join-team?token=${encodeURIComponent(
    token!,
  )}`;
  const roleName = roleLabel(invite.role);

  // Not signed in — offer sign-in / create-account, returning here afterward.
  if (!user) {
    const loginHref = getAuthUrl(
      `/login?return_to=${encodeURIComponent(acceptUrl)}`,
    );
    const signupHref = getAuthUrl(
      `/signup?return_to=${encodeURIComponent(acceptUrl)}`,
    );
    return (
      <Shell
        title={t("title", { fundName: fund.name })}
        body={t("authPrompt", {
          email: invite.email,
          fundName: fund.name,
          role: roleName,
        })}
      >
        <div className="flex flex-col gap-2">
          <a href={signupHref} className={buttonVariants({ variant: "default" })}>
            {t("createAccount")}
          </a>
          <a href={loginHref} className={buttonVariants({ variant: "outline" })}>
            {t("signIn")}
          </a>
        </div>
      </Shell>
    );
  }

  // Signed in as a different email than the invite targets.
  if (user.email.toLowerCase() !== invite.email.toLowerCase()) {
    const switchHref = `/auth/logout?return_to=${encodeURIComponent(acceptUrl)}`;
    return (
      <Shell
        title={t("mismatchTitle")}
        body={t("mismatchBody", {
          signedInAs: user.email,
          invitedEmail: invite.email,
        })}
      >
        <a href={switchHref} className={buttonVariants({ variant: "outline" })}>
          {t("switchAccount")}
        </a>
      </Shell>
    );
  }

  // Signed in and matching — ready to accept.
  return (
    <Shell
      title={t("title", { fundName: fund.name })}
      body={t("readyBody", { fundName: fund.name, role: roleName })}
    >
      <AcceptButton token={token!} />
    </Shell>
  );
}

function Shell({
  title,
  body,
  children,
}: {
  title: string;
  body: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="w-full max-w-md">
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{body}</CardDescription>
        </CardHeader>
        {children && <CardContent>{children}</CardContent>}
      </Card>
    </div>
  );
}
