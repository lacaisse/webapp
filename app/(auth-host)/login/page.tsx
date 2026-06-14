// SPDX-License-Identifier: AGPL-3.0-or-later
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
import { buildPostAuthRedirect } from "@/services/auth/redirects";
import { getApexUrl } from "@/services/fund/server";
import { LoginForm } from "./login-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ return_to?: string }>;
}) {
  const { return_to } = await searchParams;

  // Already signed in on the auth host — skip the form and bounce the user
  // through the exchange flow so the target host gets its own session cookie.
  const user = await getCurrentUser();
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

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <LoginForm />
      </CardContent>
      <CardFooter className="text-sm text-muted-foreground">
        {return_to ? (
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
          // Public self-serve signup is closed — point newcomers at the waitlist.
          <>
            {t("waitlistPrompt")}&nbsp;
            <Link
              href={getApexUrl("/#get-started")}
              className="text-foreground underline"
            >
              {t("joinWaitlist")}
            </Link>
          </>
        )}
      </CardFooter>
    </Card>
  );
}
