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
import { loadMemberSignupForm } from "@/services/member/signup-form-data";
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

  // Fields, steps, tiers and prefill — shared with the member login sign-up
  // (app/(fund-member)/member/signup), which asks the same questions plus a
  // password.
  const form = await loadMemberSignupForm(fund, params);

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
            steps={form.steps}
            referralCode={ref ?? null}
            showContribution={form.showContribution}
            tierMinimums={form.tierMinimums}
            prefill={form.prefill}
            cancelUrl={cancelUrl}
          />
        </CardContent>
      </Card>
    </div>
  );
}
