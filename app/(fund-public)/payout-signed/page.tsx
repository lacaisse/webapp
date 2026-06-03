// SPDX-License-Identifier: AGPL-3.0-or-later
import { CheckCircle2 } from "lucide-react";
import { getTranslations } from "next-intl/server";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

// Where Ponto redirects the operator after they sign a payout's bank
// transfer. Public (no auth) and fund-scoped — the signing happens on a
// phone or a browser that may not be logged into the dashboard. It just
// tells them the signing is done and they can close the tab.
export default async function PayoutSignedPage() {
  const t = await getTranslations("fund.payments.settlement.signed");

  return (
    <div className="w-full max-w-md">
      <Card>
        <CardHeader>
          <div className="mb-2 flex size-10 items-center justify-center rounded-full bg-success/15 text-success">
            <CheckCircle2 className="size-5" />
          </div>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">{t("close")}</p>
        </CardContent>
      </Card>
    </div>
  );
}
