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
import { SignupForm } from "./signup-form";

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ return_to?: string }>;
}) {
  const { return_to } = await searchParams;

  // Already signed in (e.g. shared the signup URL between tabs) — bounce
  // through the exchange flow so the target host gets its own cookie.
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

  const t = await getTranslations("auth.signup");
  const loginHref = return_to
    ? `/login?return_to=${encodeURIComponent(return_to)}`
    : "/login";

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <SignupForm />
      </CardContent>
      <CardFooter className="text-sm text-muted-foreground">
        {t("haveAccount")}&nbsp;
        <Link href={loginHref} className="text-foreground underline">
          {t("signIn")}
        </Link>
      </CardFooter>
    </Card>
  );
}
