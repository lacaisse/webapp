// SPDX-License-Identifier: AGPL-3.0-or-later
import { getTranslations } from "next-intl/server";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { prisma } from "@/services/db/prisma";
import { requireCurrentFund } from "@/services/fund/server";
import { SignupForm } from "./signup-form";

export default async function MemberSignupPage({
  searchParams,
}: {
  searchParams: Promise<{ ref?: string }>;
}) {
  const fund = await requireCurrentFund();
  const t = await getTranslations("members.signup");
  const { ref } = await searchParams;

  // Per-fund custom signup fields (the extras the admin configured on top
  // of the hardcoded firstName/lastName/email). Hidden when archived.
  const rawFields = await prisma.onboardingField.findMany({
    where: { fundId: fund.id, target: "MEMBER", archivedAt: null },
    orderBy: { position: "asc" },
    select: {
      id: true,
      key: true,
      type: true,
      label: true,
      helpText: true,
      required: true,
      config: true,
    },
  });

  const fields = rawFields.map((f) => {
    const config = (f.config as { options?: { value: string; label: string }[] } | null) ?? null;
    return {
      id: f.id,
      key: f.key,
      type: f.type,
      label: f.label,
      helpText: f.helpText,
      required: f.required,
      options: config?.options ?? [],
    };
  });

  return (
    <div className="w-full max-w-md">
      <Card>
        <CardHeader>
          <CardTitle>{t("title", { fundName: fund.name })}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <SignupForm fields={fields} referralCode={ref ?? null} />
        </CardContent>
      </Card>
    </div>
  );
}
