// SPDX-License-Identifier: AGPL-3.0-or-later
import { getTranslations } from "next-intl/server";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { contributionApplies } from "@/services/member/contribution";
import { parseSignupPrefill } from "@/services/member/prefill";
import { prisma } from "@/services/db/prisma";
import { requireCurrentFund } from "@/services/fund/server";
import { buildFormSteps } from "@/services/onboarding/form-steps";
import { SignupForm } from "./signup-form";

// A fund's own website links people here, optionally carrying what it already
// knows about them as query params (see services/member/prefill.ts). Anything
// unrecognised is ignored, so the page is safe to link to with arbitrary
// tracking params attached.
export default async function MemberSignupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const fund = await requireCurrentFund();
  const t = await getTranslations("members.signup");
  const params = await searchParams;
  const ref = typeof params.ref === "string" ? params.ref : undefined;

  // Per-fund custom signup fields (the extras the admin configured on top
  // of the hardcoded firstName/lastName/email) and the optional pages they're
  // grouped into. Both hide archived rows.
  const [rawFields, rawSteps, tierCount] = await Promise.all([
    prisma.onboardingField.findMany({
      where: { fundId: fund.id, target: "MEMBER", archivedAt: null },
      orderBy: { position: "asc" },
      select: {
        id: true,
        key: true,
        type: true,
        label: true,
        helpText: true,
        required: true,
        position: true,
        stepId: true,
        config: true,
      },
    }),
    prisma.onboardingStep.findMany({
      where: { fundId: fund.id, target: "MEMBER", archivedAt: null },
      orderBy: { position: "asc" },
      select: { id: true, title: true, description: true, position: true },
    }),
    prisma.allocationTier.count({
      where: { fundId: fund.id, archivedAt: null },
    }),
  ]);

  // The commitment-amount field only applies to FIXED_PERIOD funds with tiers.
  const showContribution = contributionApplies(fund.allocationMode, tierCount);

  const fields = rawFields.map((f) => {
    const config = (f.config as { options?: { value: string; label: string }[] } | null) ?? null;
    return {
      id: f.id,
      key: f.key,
      type: f.type,
      label: f.label,
      helpText: f.helpText,
      required: f.required,
      position: f.position,
      stepId: f.stepId,
      options: config?.options ?? [],
    };
  });

  // Prefill is resolved server-side so the first paint already shows the
  // visitor's details — no flash of empty inputs. It's convenience only:
  // signupMemberAction re-validates the submission regardless.
  const prefill = parseSignupPrefill(params, fields, { showContribution });

  const steps = buildFormSteps(rawSteps, fields);

  // The cancel target is fund config, never a request param — a public form
  // that redirects wherever the query string points is an open redirect.
  // Without an explicit URL we fall back to the fund's own website, and with
  // neither the form hides the button rather than dead-ending the visitor.
  const cancelUrl = fund.memberSignupCancelUrl ?? fund.websiteUrl;

  return (
    <div className="w-full max-w-md">
      <Card>
        <CardHeader>
          <CardTitle>{t("title", { fundName: fund.name })}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <SignupForm
            steps={steps}
            referralCode={ref ?? null}
            showContribution={showContribution}
            prefill={prefill}
            cancelUrl={cancelUrl}
          />
        </CardContent>
      </Card>
    </div>
  );
}
