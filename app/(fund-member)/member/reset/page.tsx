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
import { MemberResetForm } from "./reset-form";

// Lands from the reset email (`/reset?token=…` on this fund host — the
// member forgot action asked Better Auth for that redirect).
export default async function MemberResetPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; error?: string }>;
}) {
  await getCurrentMember(); // 404 when member login is off
  const t = await getTranslations("memberLogin.reset");
  const { token, error } = await searchParams;
  const usable = Boolean(token) && !error;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{usable ? t("description") : t("invalid")}</CardDescription>
      </CardHeader>
      {usable && (
        <CardContent>
          <MemberResetForm token={token!} />
        </CardContent>
      )}
      <CardFooter className="text-sm text-muted-foreground">
        <Link href={usable ? "/login" : "/forgot"} className="text-foreground underline">
          {usable ? t("backToLogin") : t("requestAgain")}
        </Link>
      </CardFooter>
    </Card>
  );
}
