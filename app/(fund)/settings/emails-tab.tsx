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
import {
  sendTestAllocationEmailAction,
  sendTestCardAssignedEmailAction,
  sendTestPaymentReminderEmailAction,
} from "@/services/email/template-actions";
import { getEmailTemplateForEditing } from "@/services/email/templates";
import { EmailSettings } from "./email-settings";
import { EmailTemplateForm } from "./email-template-form";
import { MemberSenderForm } from "./member-sender-form";

// "Emails" settings tab: the member-notification pause switch, the custom
// sender address, plus the editable per-fund templates (allocation
// confirmation, card-assigned, payment reminder) — each with a live preview
// and a test-send
// picker. Server component — it loads each fund template override (or the
// built-in default) and the members that can seed a test, then hands them to
// the client editors.
export async function EmailsTab({
  fund,
  initialPaused,
}: {
  fund: { id: string; defaultLocale: string; senderEmail: string | null };
  initialPaused: boolean;
}) {
  const t = await getTranslations("fund.settings");

  const [allocation, cardAssigned, paymentReminder] = await Promise.all([
    getEmailTemplateForEditing({ type: "ALLOCATION_CONFIRMATION", fund }),
    getEmailTemplateForEditing({ type: "CARD_ASSIGNED", fund }),
    getEmailTemplateForEditing({ type: "PAYMENT_REMINDER_FIRST", fund }),
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
          <EmailTemplateForm
            type="ALLOCATION_CONFIRMATION"
            initial={allocation.override ?? allocation.base}
            base={allocation.base}
            hasOverride={allocation.override !== null}
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
            initial={cardAssigned.override ?? cardAssigned.base}
            base={cardAssigned.base}
            hasOverride={cardAssigned.override !== null}
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
            initial={paymentReminder.override ?? paymentReminder.base}
            base={paymentReminder.base}
            hasOverride={paymentReminder.override !== null}
            variables={paymentReminder.variables}
            testMembers={reminderMembers}
            testAction={sendTestPaymentReminderEmailAction}
          />
        </CardContent>
      </Card>
    </div>
  );
}
