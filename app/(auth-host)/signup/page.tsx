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
import { SignupForm } from "./signup-form";

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<{ return_to?: string }>;
}) {
  const { return_to } = await searchParams;

  // Already signed in (e.g. user clicked the email-verify link, or shared the
  // signup URL between tabs) — hand off rather than re-prompting.
  const user = await getCurrentUser();
  if (user?.email) {
    const { url } = await buildLoginRedirect({
      userId: user.id,
      email: user.email,
      returnTo: return_to,
    });
    redirect(url);
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
