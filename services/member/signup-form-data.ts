// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import type { AllocationMode } from "@/services/db/generated/enums";
import { prisma } from "@/services/db/prisma";
import { contributionApplies } from "@/services/member/contribution";
import { parseSignupPrefill, type SignupPrefill } from "@/services/member/prefill";
import { buildFormSteps, type FormStep } from "@/services/onboarding/form-steps";
import { parseVisibleIf, type VisibleIf } from "@/services/onboarding/visibility";

// Everything the public member sign-up form needs from the database, for the
// /join page (application, no login) and the member /signup page (login) —
// both render the same SignupForm over the fund's OnboardingFields.

export type SignupFormField = {
  id: string;
  key: string;
  type:
    | "TEXT"
    | "TEXTAREA"
    | "EMAIL"
    | "PHONE"
    | "NUMBER"
    | "SELECT"
    | "MULTISELECT"
    | "CHECKBOX"
    | "DATE";
  label: string;
  helpText: string | null;
  required: boolean;
  position: number;
  stepId: string | null;
  options: { value: string; label: string }[];
  visibleIf: VisibleIf | null;
};

export type SignupFormData = {
  steps: FormStep<SignupFormField>[];
  showContribution: boolean;
  tierMinimums: Record<string, number>;
  prefill: SignupPrefill;
};

export async function loadMemberSignupForm(
  fund: { id: string; allocationMode: AllocationMode },
  params: Record<string, string | string[] | undefined>,
): Promise<SignupFormData> {
  // Per-fund custom signup fields (the extras the admin configured on top
  // of the hardcoded firstName/lastName/email) and the optional pages they're
  // grouped into. Both hide archived rows.
  const [rawFields, rawSteps, tiers, contributionFieldRow] = await Promise.all([
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
        visibleIf: true,
        builtinKey: true,
      },
    }),
    prisma.onboardingStep.findMany({
      where: { fundId: fund.id, target: "MEMBER", archivedAt: null },
      orderBy: { position: "asc" },
      select: { id: true, title: true, description: true, position: true },
    }),
    // Signup-visible tiers only: hiddenAtSignup tiers stay assignable by admins
    // but are never offered to applicants (issue #37). The sign-up actions
    // apply the same filter as the authoritative allowlist.
    prisma.allocationTier.findMany({
      where: { fundId: fund.id, archivedAt: null, hiddenAtSignup: false },
      orderBy: { position: "asc" },
      select: {
        id: true,
        name: true,
        allocationAmount: true,
        minContribution: true,
      },
    }),
    // Who owns the commitment-amount question (issue #179). No row at all →
    // the legacy hardcoded input below. Any row — active OR archived — means
    // the admin took it over via Settings → Onboarding: an active row renders
    // like every other field (their label/help/required/position), an
    // archived row hides the question entirely. Queried without the
    // archivedAt filter for exactly that reason.
    prisma.onboardingField.findUnique({
      where: {
        fundId_target_key: {
          fundId: fund.id,
          target: "MEMBER",
          key: "contributionAmount",
        },
      },
      select: { id: true },
    }),
  ]);

  // The commitment-amount field only applies to FIXED_PERIOD funds with
  // tiers, and the legacy hardcoded input only renders while no admin has
  // taken the question over as a configurable field (issue #179).
  const contributionAllowed = contributionApplies(fund.allocationMode, tiers.length);
  const showContribution = contributionAllowed && contributionFieldRow === null;

  const fields: SignupFormField[] = rawFields
    // An admin-configured commitment-amount field is still subject to the
    // FIXED_PERIOD-with-tiers gate — on a fund where the concept doesn't
    // exist the question is withheld, exactly like the legacy input (the
    // actions drop the value server-side regardless).
    .filter((f) => f.builtinKey !== "contributionAmount" || contributionAllowed)
    .map((f) => {
      const config =
        (f.config as { options?: { value: string; label: string }[] } | null) ?? null;
      // The tier picker (issue #157) is never admin-customizable — its options
      // are always the fund's current live tiers, not OnboardingField.config.
      // The allocation amount rides along in the label (#186): applicants
      // choose by amount, and a bare tier name like "Basse" doesn't say it.
      const options =
        f.builtinKey === "tierId"
          ? tiers.map((tier) => ({
              value: tier.id,
              label: `${tier.name} — ${Number(tier.allocationAmount)} €`,
            }))
          : (config?.options ?? []);
      return {
        id: f.id,
        key: f.key,
        type: f.type,
        label: f.label,
        helpText: f.helpText,
        required: f.required,
        position: f.position,
        stepId: f.stepId,
        options,
        visibleIf: parseVisibleIf(f.visibleIf),
      };
    });

  // Prefill is resolved server-side so the first paint already shows the
  // visitor's details — no flash of empty inputs. It's convenience only:
  // the actions re-validate the submission regardless.
  const prefill = parseSignupPrefill(params, fields, { showContribution });

  return {
    steps: buildFormSteps(rawSteps, fields),
    showContribution,
    tierMinimums: Object.fromEntries(
      tiers.map((tier) => [tier.id, Number(tier.minContribution)]),
    ),
    prefill,
  };
}
