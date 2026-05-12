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
  const signupHref = return_to
    ? `/signup?return_to=${encodeURIComponent(return_to)}`
    : "/signup";

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
        {t("noAccount")}&nbsp;
        <Link href={signupHref} className="text-foreground underline">
          {t("createAccount")}
        </Link>
      </CardFooter>
    </Card>
  );
}
