// SPDX-License-Identifier: AGPL-3.0-or-later
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getCurrentMember } from "@/services/auth/dal";
import { prisma } from "@/services/db/prisma";
import { FUND_APEX, getFundUrl } from "@/services/fund/host";
import { getAuthUrl, isServerActionRequest } from "@/services/host/server";
import { sameOriginPath } from "@/services/http/same-origin-path";
import { MemberLoginForm } from "./login-form";
import { ResendPendingVerification } from "./resend-pending-verification";

// Member sign-in on the fund host (password, or a passkey — the WebAuthn
// rpID is the apex, so a fund on its own `<sub>.<apex>` host can run the
// ceremony itself). A fund on a paid custom domain can't: its members sign
// in on the auth host, branded by the `fund` hint, and come back with a
// session through /auth/exchange like staff do.

const NOTICES = new Set([
  "check_email",
  "verified",
  "password_reset",
  "login_removed",
  "unlinked",
  "no_membership",
  "confirm_login",
]);


export default async function MemberLoginPage({
  searchParams,
}: {
  searchParams: Promise<{ return_to?: string; notice?: string }>;
}) {
  const { return_to, notice } = await searchParams;
  const { user, fund, member } = await getCurrentMember();
  // A path on this fund's own origin, or nothing (services/http/same-origin-path.ts).
  const returnTo = sameOriginPath(return_to, getFundUrl(fund.domain), "") || undefined;

  if (user && member) {
    // Mid-action (the login action just set the cookie): the form navigates
    // itself; a redirect here would be resolved against the wrong host.
    if (await isServerActionRequest()) return null;
    redirect(returnTo ?? "/account");
  }

  // Custom domain: no passkeys here (rpID = the apex) — hand over to the
  // auth host, which brands itself with this fund and exchanges back.
  if (!fund.domain.endsWith(`.${FUND_APEX}`) && !user) {
    const target = `${getFundUrl(fund.domain)}${returnTo ?? "/account"}`;
    redirect(
      getAuthUrl(
        `/login?fund=${encodeURIComponent(fund.domain)}&return_to=${encodeURIComponent(target)}`,
      ),
    );
  }

  const t = await getTranslations("memberLogin.login");
  const noticeKey = notice && NOTICES.has(notice) ? notice : null;

  // A signed-in User without a membership here may be a link-mode sign-up
  // whose confirmation email never arrived: offer to send it again.
  const pendingVerification =
    user && !member
      ? await prisma.emailVerification.findFirst({
          where: { userId: user.id, consumedAt: null, member: { fundId: fund.id } },
          select: { token: true },
        })
      : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title", { fundName: fund.name })}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {noticeKey && (
          <Alert>
            <AlertDescription>{t(`notices.${noticeKey}` as never)}</AlertDescription>
          </Alert>
        )}
        {user && !member ? (
          // Signed in on this host (e.g. staff of this fund, or a member of
          // another fund) without a membership here.
          <div className="space-y-3 text-sm">
            <p>{t("signedInAs", { email: user.email })}</p>
            <p className="text-muted-foreground">
              {pendingVerification
                ? t("pendingVerification", { fundName: fund.name })
                : t("noMembership", { fundName: fund.name })}
            </p>
            {pendingVerification && <ResendPendingVerification />}
            <div className="flex flex-wrap gap-2">
              {/* The logout route handler answers with a real redirect, so
                  the browser comes back through the proxy to this page. */}
              <form
                action={`/auth/logout?return_to=${encodeURIComponent(`${getFundUrl(fund.domain)}/login`)}`}
                method="post"
              >
                <Button type="submit" variant="outline">
                  {t("signOut")}
                </Button>
              </form>
              <Link href="/signup" className="inline-flex items-center text-sm underline">
                {t("createLogin")}
              </Link>
            </div>
          </div>
        ) : (
          <MemberLoginForm returnTo={returnTo} />
        )}
      </CardContent>
      <CardFooter className="text-sm text-muted-foreground">
        {t("noLogin")}&nbsp;
        <Link href="/signup" className="text-foreground underline">
          {t("createLogin")}
        </Link>
      </CardFooter>
    </Card>
  );
}
