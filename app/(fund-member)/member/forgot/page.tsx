// SPDX-License-Identifier: AGPL-3.0-or-later
import { getTranslations } from "next-intl/server";
import Link from "next/link";

import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getCurrentMember } from "@/services/auth/dal";
import { MemberForgotForm } from "./forgot-form";

export default async function MemberForgotPage() {
  await getCurrentMember(); // 404 when member login is off
  const t = await getTranslations("memberLogin.forgot");
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <MemberForgotForm />
      </CardContent>
      <CardFooter className="text-sm text-muted-foreground">
        <Link href="/login" className="text-foreground underline">
          {t("backToLogin")}
        </Link>
      </CardFooter>
    </Card>
  );
}
