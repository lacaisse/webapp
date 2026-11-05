// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getCurrentUser } from "@/services/auth/dal";
import { readSignedOAuthQuery } from "@/services/auth/oauth-resume";
import { buildPostAuthRedirect } from "@/services/auth/redirects";
import { getApexUrl } from "@/services/fund/server";
import { resolveMemberFundHint } from "@/services/member/fund-hint";
import { LoginForm } from "./login-form";

// return_to may carry an invite code (/new?code=, from the apex /join door):
// no Referer leaves this page.
export const metadata: Metadata = { referrer: "no-referrer" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ return_to?: string; fund?: string }>;
}) {
  const { return_to, fund: fundParam } = await searchParams;

  // Mid-MCP-OAuth: the provider plugin sent the browser here with a signed
  // copy of the authorize query. The form hands it back to loginAction so
  // the plugin can resume (services/auth/oauth-query.ts). A signed-in user
  // only lands here with it on `prompt=login`, which wants a fresh sign-in —
  // so no short-circuit in that case.
  const oauthQuery = await readSignedOAuthQuery();

  // Already signed in on the auth host — skip the form and bounce the user
  // through the exchange flow so the target host gets its own session cookie.
  const user = oauthQuery ? null : await getCurrentUser();
  if (user) {
    redirect(
      await buildPostAuthRedirect({
        userId: user.id,
        email: user.email,
        returnTo: return_to,
      }),
    );
  }

  const t = await getTranslations("auth.login");

  // Member login (plan "Bread card-holder voting"): the card wallet's
  // authorize request carries `fund=<treasury slug>`, which the provider
  // passes through into the signed query — so does a custom-domain fund's
  // own /login when it hands members over here. Brand the page with that
  // fund and point newcomers at its member sign-up.
  const fundHint = await resolveMemberFundHint(
    oauthQuery ? new URLSearchParams(oauthQuery).get("fund") : fundParam,
  );

  return (
    <Card>
      <CardHeader>
        {fundHint && (
          <div className="mb-2 flex items-center gap-3">
            {fundHint.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={fundHint.logoUrl}
                alt={fundHint.name}
                className="h-10 w-auto object-contain"
              />
            ) : (
              <span
                className="flex size-10 items-center justify-center rounded-full text-base font-semibold text-white"
                style={{ backgroundColor: fundHint.primaryColor ?? "#1a1a1a" }}
                aria-hidden
              >
                {fundHint.name.slice(0, 1).toUpperCase()}
              </span>
            )}
            <div className="text-sm">
              <div className="font-medium">
                {t("memberHint.title", { fundName: fundHint.name })}
              </div>
              <div className="text-muted-foreground">{t("memberHint.description")}</div>
            </div>
          </div>
        )}
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <LoginForm oauthQuery={oauthQuery ?? undefined} />
      </CardContent>
      <CardFooter className="text-sm text-muted-foreground">
        {fundHint ? (
          // A member without a login yet: the fund's own sign-up page.
          <>
            {t("noAccount")}&nbsp;
            <a href={fundHint.signupUrl} className="text-foreground underline">
              {t("memberHint.createLogin", { fundName: fundHint.name })}
            </a>
          </>
        ) : return_to ? (
          // Invited users (e.g. a team-invite accept URL) can still create an
          // account — keep the path open for them.
          <>
            {t("noAccount")}&nbsp;
            <Link
              href={`/signup?return_to=${encodeURIComponent(return_to)}`}
              className="text-foreground underline"
            >
              {t("createAccount")}
            </Link>
          </>
        ) : (
          // There is no sign-up of its own: an account is made by starting a
          // fund at the apex /join door (or by accepting an invite, above).
          <span>
            {t("startFundPrompt")}&nbsp;
            <Link href={getApexUrl("/join")} className="text-foreground underline">
              {t("startFund")}
            </Link>
          </span>
        )}
      </CardFooter>
    </Card>
  );
}
