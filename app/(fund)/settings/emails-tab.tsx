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
import { getAllocationTemplateForEditing } from "@/services/email/templates";
import { AllocationTemplateForm } from "./allocation-template-form";
import { EmailSettings } from "./email-settings";
import { MemberSenderForm } from "./member-sender-form";

// "Emails" settings tab: the member-notification pause switch, the custom
// sender address, plus the editable allocation-confirmation template (with a
// test-send picker). Server component — it loads the fund's template override
// (or the built-in default) and a list of members for the test picker, and
// hands them to the client editor.
export async function EmailsTab({
  fund,
  initialPaused,
}: {
  fund: { id: string; defaultLocale: string; senderEmail: string | null };
  initialPaused: boolean;
}) {
  const t = await getTranslations("fund.settings");
  const { override, base, variables } = await getAllocationTemplateForEditing({
    fund,
  });

  // Members that can seed a test allocation email — ACTIVE with a tier (the
  // tier supplies the {amount}). Ordered by name for the picker.
  const members = await prisma.member.findMany({
    where: { fundId: fund.id, status: "ACTIVE", tierId: { not: null } },
    select: { id: true, firstName: true, lastName: true, email: true },
    orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
    take: 500,
  });

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

      <Card>
        <CardHeader>
          <CardTitle>{t("emailTemplates.allocationTitle")}</CardTitle>
          <CardDescription>
            {t("emailTemplates.allocationDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent className="pb-4">
          <AllocationTemplateForm
            initial={override ?? base}
            base={base}
            hasOverride={override !== null}
            variables={variables}
            testMembers={members}
          />
        </CardContent>
      </Card>
    </div>
  );
}
