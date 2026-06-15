// SPDX-License-Identifier: AGPL-3.0-or-later
import { getTranslations } from "next-intl/server";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { getAllocationTemplateForEditing } from "@/services/email/templates";
import { AllocationTemplateForm } from "./allocation-template-form";
import { EmailSettings } from "./email-settings";

// "Emails" settings tab: the member-notification pause switch plus the
// editable allocation-confirmation template. Server component — it loads the
// fund's template override (or the built-in default) and hands it to the
// client editor.
export async function EmailsTab({
  fund,
  initialPaused,
}: {
  fund: { id: string; defaultLocale: string };
  initialPaused: boolean;
}) {
  const t = await getTranslations("fund.settings");
  const { override, base, variables } = await getAllocationTemplateForEditing({
    fund,
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("emails.title")}</CardTitle>
          <CardDescription>{t("emails.description")}</CardDescription>
        </CardHeader>
        <CardContent className="pb-4">
          <EmailSettings initialPaused={initialPaused} />
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
          />
        </CardContent>
      </Card>
    </div>
  );
}
