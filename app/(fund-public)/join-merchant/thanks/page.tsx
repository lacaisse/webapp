import { getTranslations } from "next-intl/server";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireCurrentFund } from "@/services/fund/server";

export default async function MerchantSignupThanksPage() {
  const fund = await requireCurrentFund();
  const key = fund.requireMerchantEmailVerification ? "checkEmail" : "applied";
  const t = await getTranslations(`merchants.signup.thanks.${key}`);

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
          <p className="text-sm text-muted-foreground">
            {t("nextSteps", { fundName: fund.name })}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
