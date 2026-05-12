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
import { MerchantSignupForm } from "./signup-form";

export default async function MerchantSignupPage() {
  const fund = await requireCurrentFund();
  const t = await getTranslations("merchants.signup");

  const fields = await prisma.onboardingField.findMany({
    where: { fundId: fund.id, target: "MERCHANT", archivedAt: null },
    orderBy: { position: "asc" },
    select: {
      id: true,
      key: true,
      type: true,
      label: true,
      helpText: true,
      required: true,
    },
  });

  return (
    <div className="w-full max-w-lg">
      <Card>
        <CardHeader>
          <CardTitle>{t("title", { fundName: fund.name })}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <MerchantSignupForm fields={fields} />
        </CardContent>
      </Card>
    </div>
  );
}
