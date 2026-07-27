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
import { EDITABLE_EMAIL_TYPES } from "@/services/email/template-config";
import { getEmailTemplateLibrary } from "@/services/email/templates";
import { EmailTemplateSection } from "./email-template-section";

// The "Templates" tab of the Emails section: for each member-facing email type,
// the built-in default plus the fund's own library of custom templates, with a
// picker choosing which one the system sends (falling back to the default). The
// default is never editable in place — admins duplicate it to customise, so the
// originals can't be broken. Server component — it loads every type's library
// (default content + templates + active assignment) plus a member pool to seed
// test sends, then hands them to the client sections.
export async function EmailTemplatesPanel() {
  const t = await getTranslations("fund.settings.emailTemplates");
  const fund = await requireCurrentFund();

  const [libraries, testMembers] = await Promise.all([
    Promise.all(
      EDITABLE_EMAIL_TYPES.map((type) =>
        getEmailTemplateLibrary({ type, fundId: fund.id }),
      ),
    ),
    prisma.member.findMany({
      where: { fundId: fund.id, status: "ACTIVE" },
      select: { id: true, firstName: true, lastName: true, email: true },
      orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
      take: 500,
    }),
  ]);

  return (
    <div className="space-y-6">
      {libraries.map((library) => (
        <Card key={library.type}>
          <CardHeader>
            <CardTitle>{t(`types.${library.type}.title`)}</CardTitle>
            <CardDescription>
              {t(`types.${library.type}.description`)}
            </CardDescription>
          </CardHeader>
          <CardContent className="pb-4">
            <EmailTemplateSection
              library={library}
              defaultLocale={fund.defaultLocale}
              testMembers={testMembers}
            />
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
