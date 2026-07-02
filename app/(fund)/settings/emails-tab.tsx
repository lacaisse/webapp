// SPDX-License-Identifier: AGPL-3.0-or-later
import { getTranslations } from "next-intl/server";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { EmailSettings } from "./email-settings";
import { MemberSenderForm } from "./member-sender-form";

// "Emails" settings tab: the member-notification pause switch and the custom
// sender address. The editable per-fund email templates live in the Emails
// section (/emails → Templates tab), not here.
export async function EmailsTab({
  fund,
  initialPaused,
}: {
  fund: { id: string; defaultLocale: string; senderEmail: string | null };
  initialPaused: boolean;
}) {
  const t = await getTranslations("fund.settings");

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("emails.title")}</CardTitle>
          <CardDescription>{t("emails.description")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6 pb-4">
          <EmailSettings initialPaused={initialPaused} />
          <MemberSenderForm initialSenderEmail={fund.senderEmail} />
        </CardContent>
      </Card>
    </div>
  );
}
