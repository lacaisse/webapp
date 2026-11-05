// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireUser } from "@/services/auth/dal";
import { findUsableWaiverCode } from "@/services/fund-setup/waiver-claim";
import { formatWaiverCode } from "@/services/fund-setup/waiver-codes";
import { CreateFundForm } from "./create-fund-form";

// ?code= may carry an invite code: no Referer leaves this page.
export const metadata: Metadata = { referrer: "no-referrer" };

export default async function NewFundPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string | string[] }>;
}) {
  // (apex) layout already bounced any non-apex host here, so there's no fund
  // context to worry about — getCurrentFund would always be null. Any
  // signed-in account may open a fund: the door is as open as the apex
  // /join's, where a stranger creates account and fund together, and the
  // fund costs its subscription before it runs (the dashboard's setup
  // checklist). A card holder's member login (services/member/auth.ts) may
  // too — it becomes OWNER of the new fund only, never staff of the fund it
  // holds a card at.
  await requireUser();
  const params = await searchParams;
  const rawCode = typeof params.code === "string" ? params.code.trim() : "";

  // A code that came along (?code=, from /join) is used whoever brought it:
  // the fund starts waived (createFundAction claims the use in the same
  // transaction). One that no longer checks out — used up, revoked or
  // expired since the link was shared — is said so, over the plain form.
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
