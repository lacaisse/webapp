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
import { SignupForm } from "@/app/(fund-public)/join/signup-form";
import { getCurrentMember } from "@/services/auth/dal";
import { isServerActionRequest } from "@/services/host/server";
import { signUpMemberAction } from "@/services/member/auth-actions";
import { loadMemberSignupForm } from "@/services/member/signup-form-data";

// Member LOGIN sign-up: the /join application form (same fields, steps and
// prefill — services/member/signup-form-data.ts) plus a password. Creates the
// User and, for a new address, the Member; an existing member of the fund is
// linked once the verification email is clicked (services/member/auth.ts).

export default async function MemberSignupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user, fund, member } = await getCurrentMember();
  if (user && member) {
    if (await isServerActionRequest()) return null;
    redirect("/account");
  }

  const t = await getTranslations("memberLogin.signup");
  const params = await searchParams;
  const ref = typeof params.ref === "string" ? params.ref : undefined;
  const form = await loadMemberSignupForm(fund, params);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title", { fundName: fund.name })}</CardTitle>
        <CardDescription>{t("description", { fundName: fund.name })}</CardDescription>
      </CardHeader>
      <CardContent>
        <SignupForm
          steps={form.steps}
          referralCode={ref ?? null}
          showContribution={form.showContribution}
          tierMinimums={form.tierMinimums}
          prefill={form.prefill}
          cancelUrl={null}
          withPassword
          action={signUpMemberAction}
          labels={{
            submit: t("submit"),
            submitting: t("submitting"),
            password: t("password"),
            confirmPassword: t("confirmPassword"),
            passwordHint: t("passwordHint"),
          }}
        />
      </CardContent>
      <CardFooter className="text-sm text-muted-foreground">
        {t("haveLogin")}&nbsp;
        <Link href="/login" className="text-foreground underline">
          {t("signIn")}
        </Link>
      </CardFooter>
    </Card>
  );
}
