// SPDX-License-Identifier: AGPL-3.0-or-later
import { getTranslations } from "next-intl/server";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type ErrorReason = "missing" | "not_found" | "expired" | "email_mismatch";

const ALLOWED: ErrorReason[] = [
  "missing",
  "not_found",
  "expired",
  "email_mismatch",
];

function normaliseReason(raw: string | undefined): ErrorReason {
  return ALLOWED.includes(raw as ErrorReason)
    ? (raw as ErrorReason)
    : "not_found";
}

export default async function VerifyEmailErrorPage({
  searchParams,
}: {
  searchParams: Promise<{ reason?: string }>;
}) {
  const { reason: rawReason } = await searchParams;
  const reason = normaliseReason(rawReason);
  const t = await getTranslations("verifyEmail.error");

  return (
    <div className="w-full max-w-md">
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t(`reasons.${reason}`)}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{t("nextSteps")}</p>
        </CardContent>
      </Card>
    </div>
  );
}
