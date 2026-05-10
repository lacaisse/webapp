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
import { buildLoginRedirect } from "@/services/auth/post-login";
import { LoginForm } from "./login-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ return_to?: string }>;
}) {
  const { return_to } = await searchParams;

  // Already signed in on the auth host — skip the form and walk the same
  // post-login path the form would, handing off to `return_to` (or apex).
  const user = await getCurrentUser();
  if (user?.email) {
    const { url } = await buildLoginRedirect({
      userId: user.id,
      email: user.email,
      returnTo: return_to,
    });
    redirect(url);
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
