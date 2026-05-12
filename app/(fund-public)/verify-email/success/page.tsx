import { getTranslations } from "next-intl/server";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireCurrentFund } from "@/services/fund/server";

export default async function VerifyEmailSuccessPage() {
  const fund = await requireCurrentFund();
  const t = await getTranslations("verifyEmail.success");

  return (
    <div className="w-full max-w-md">
      <Card>
        <CardHeader>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>
            {t("description", { fundName: fund.name })}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{t("nextSteps")}</p>
        </CardContent>
      </Card>
    </div>
  );
}
