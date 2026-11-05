// SPDX-License-Identifier: AGPL-3.0-or-later
import { getTranslations } from "next-intl/server";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireFundCreator } from "@/services/auth/dal";
import { findUsableWaiverCode } from "@/services/fund-setup/waiver-claim";
import { formatWaiverCode } from "@/services/fund-setup/waiver-codes";
import { CreateFundForm } from "./create-fund-form";

export default async function NewFundPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string | string[] }>;
}) {
  // (apex) layout already bounced any non-apex host here, so there's no fund
  // context to worry about — getCurrentFund would always be null. Only
  // existing staff, a platform admin, or the holder of a usable subscription
  // waiver code (?code=, the apex /join door for someone who already has an
  // account) may open a fund: a member login is a User too and must not
  // become a fund OWNER without one of those.
  const params = await searchParams;
  const rawCode = typeof params.code === "string" ? params.code.trim() : "";
  await requireFundCreator(rawCode || undefined);

  // A code that came along is used whoever brought it: the fund starts
  // waived (createFundAction claims the use in the same transaction). Staff
  // with a code that no longer checks out still get the plain form.
  const waiver = rawCode ? await findUsableWaiverCode(rawCode) : null;

  const [t, tRoot] = await Promise.all([getTranslations("funds.create"), getTranslations()]);

  return (
    <div className="flex flex-1 items-start justify-center bg-muted/40 px-4 py-12">
      <div className="w-full max-w-md">
        <Card>
          <CardHeader>
            <CardTitle>{t("title")}</CardTitle>
            <CardDescription>
              {t.rich("description", {
                code: (chunks) => <code>{chunks}</code>,
              })}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {waiver && (
              <Alert>
                <AlertDescription>{t("waived", { label: waiver.label })}</AlertDescription>
              </Alert>
            )}
            {rawCode && !waiver && (
              <Alert variant="destructive">
                <AlertDescription>{tRoot("join.errors.codeInvalid")}</AlertDescription>
              </Alert>
            )}
            <CreateFundForm waiverCode={waiver ? formatWaiverCode(waiver.code) : undefined} />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
