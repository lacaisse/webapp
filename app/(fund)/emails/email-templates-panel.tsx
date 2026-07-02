// SPDX-License-Identifier: AGPL-3.0-or-later
import { getTranslations } from "next-intl/server";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireCurrentFund } from "@/services/fund/server";
import { prisma } from "@/services/db/prisma";
import {
  sendTestAllocationEmailAction,
  sendTestCardAssignedEmailAction,
  sendTestPaymentReminderEmailAction,
} from "@/services/email/template-actions";
import { getEmailTemplatesForEditing } from "@/services/email/templates";
import { EmailTemplateForm } from "./email-template-form";

// The "Templates" tab of the Emails section: the editable per-fund email
// templates (allocation confirmation, card-assigned, payment reminder), each
// authored independently per language with a live preview and a test-send
// picker. Server component — it loads every editable locale for each template
// (override or built-in default) plus the members that can seed a test, then
// hands them to the client editors.
export async function EmailTemplatesPanel() {
  const t = await getTranslations("fund.settings");
  const fund = await requireCurrentFund();

  const [allocation, cardAssigned, paymentReminder] = await Promise.all([
    getEmailTemplatesForEditing({
      type: "ALLOCATION_CONFIRMATION",
      fundId: fund.id,
    }),
    getEmailTemplatesForEditing({ type: "CARD_ASSIGNED", fundId: fund.id }),
    getEmailTemplatesForEditing({
      type: "PAYMENT_REMINDER_FIRST",
      fundId: fund.id,
    }),
  ]);

  // Test-send picker pools. Allocation needs a tier (supplies {amount});
  // card-assigned needs a primary card (supplies {cardLink}/{cardNumber});
  // the payment reminder needs both (a tier for {amount}, a card for {cardLink}).
  const [allocationMembers, cardMembers, reminderMembers] = await Promise.all([
    prisma.member.findMany({
      where: { fundId: fund.id, status: "ACTIVE", tierId: { not: null } },
      select: { id: true, firstName: true, lastName: true, email: true },
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
      take: 500,
    }),
    prisma.member.findMany({
      where: {
        fundId: fund.id,
        status: "ACTIVE",
        primaryCardId: { not: null },
      },
      select: { id: true, firstName: true, lastName: true, email: true },
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
      take: 500,
    }),
    prisma.member.findMany({
      where: {
        fundId: fund.id,
        status: "ACTIVE",
        tierId: { not: null },
        primaryCardId: { not: null },
      },
      select: { id: true, firstName: true, lastName: true, email: true },
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
      take: 500,
    }),
  ]);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("emailTemplates.allocationTitle")}</CardTitle>
          <CardDescription>
            {t("emailTemplates.allocationDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent className="pb-4">
          <EmailTemplateForm
            type="ALLOCATION_CONFIRMATION"
            byLocale={allocation.byLocale}
            defaultLocale={fund.defaultLocale}
            variables={allocation.variables}
            testMembers={allocationMembers}
            testAction={sendTestAllocationEmailAction}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("emailTemplates.cardAssignedTitle")}</CardTitle>
          <CardDescription>
            {t("emailTemplates.cardAssignedDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent className="pb-4">
          <EmailTemplateForm
            type="CARD_ASSIGNED"
            byLocale={cardAssigned.byLocale}
            defaultLocale={fund.defaultLocale}
            variables={cardAssigned.variables}
            testMembers={cardMembers}
            testAction={sendTestCardAssignedEmailAction}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("emailTemplates.paymentReminderTitle")}</CardTitle>
          <CardDescription>
            {t("emailTemplates.paymentReminderDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent className="pb-4">
          <EmailTemplateForm
            type="PAYMENT_REMINDER_FIRST"
            byLocale={paymentReminder.byLocale}
            defaultLocale={fund.defaultLocale}
            variables={paymentReminder.variables}
            testMembers={reminderMembers}
            testAction={sendTestPaymentReminderEmailAction}
          />
        </CardContent>
      </Card>
    </div>
  );
}
