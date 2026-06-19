// SPDX-License-Identifier: AGPL-3.0-or-later
import { getTranslations } from "next-intl/server";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { DOCUMENT_TEMPLATES } from "@/services/document/config";
import { getDocumentTemplateForEditing } from "@/services/document/templates";
import { DocumentTemplateForm } from "./document-template-form";

// "Documents" settings tab: the editable per-fund printable documents. Today
// that's the card onboarding letter (downloaded as a PDF from the card detail
// page). Server component — loads the fund's override (or the built-in default)
// and hands it to the client editor.
export async function DocumentsTab({
  fund,
}: {
  fund: { id: string; defaultLocale: string };
}) {
  const t = await getTranslations("fund.settings");

  const onboarding = await getDocumentTemplateForEditing({
    type: "CARD_ONBOARDING_LETTER",
    fund,
  });

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>
            {t("documentTemplates.onboardingLetterTitle")}
          </CardTitle>
          <CardDescription>
            {t("documentTemplates.onboardingLetterDescription")}
          </CardDescription>
        </CardHeader>
        <CardContent className="pb-4">
          <DocumentTemplateForm
            type="CARD_ONBOARDING_LETTER"
            initial={onboarding.override ?? onboarding.base}
            base={onboarding.base}
            hasOverride={onboarding.override !== null}
            variables={DOCUMENT_TEMPLATES.CARD_ONBOARDING_LETTER.variables}
          />
        </CardContent>
      </Card>
    </div>
  );
}
