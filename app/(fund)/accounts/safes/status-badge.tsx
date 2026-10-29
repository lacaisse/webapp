// SPDX-License-Identifier: AGPL-3.0-or-later
import { Loader2 } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { Badge } from "@/components/ui/badge";
import type { FundSafeStatus } from "@/services/db/generated/enums";

export async function SafeStatusBadge({ status }: { status: FundSafeStatus }) {
  const t = await getTranslations("fund.safes.status");
  if (status === "DEPLOYING") {
    return (
      <Badge variant="info">
        <Loader2 className="animate-spin" />
        {t("DEPLOYING")}
      </Badge>
    );
  }
  if (status === "FAILED") {
    return <Badge variant="destructive">{t("FAILED")}</Badge>;
  }
  return <Badge variant="success">{t("ACTIVE")}</Badge>;
}
