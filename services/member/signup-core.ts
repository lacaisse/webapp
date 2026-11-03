// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import type { AllocationMode } from "@/services/db/generated/enums";
import { prisma } from "@/services/db/prisma";
import { isFieldVisible, parseVisibleIf } from "@/services/onboarding/visibility";

import {
  coerceBuiltinValue,
  isMemberBuiltinKey,
  type BuiltinColumnValue,
} from "./builtin-fields";
import { contributionApplies, isBelowTierMinimum } from "./contribution";
import type { BuiltinSignupInput, ExtraValue } from "./schema";

// The part of the public member sign-up that is the same whether the
// visitor applies on /join (services/member/actions.ts, no login) or creates
// a member LOGIN on /signup (services/member/auth.ts): the commitment amount
// gate, the fund's OnboardingFields (required / visibleIf / builtin columns
// / tier allowlist) and the referral code. Returns the exact columns the
// Member row gets, or the first error the visitor can fix.

export type SignupFund = {
  id: string;
  allocationMode: AllocationMode;
};

export type SignupTranslate = (
  key: string,
  values?: Record<string, string | number>,
) => string;

export type ResolvedMemberSignup = {
  // Null when the fund doesn't take a commitment amount (not FIXED_PERIOD
  // with tiers), or the visitor left it blank.
  contributionAmount: string | null;
  // Typed Member columns the fund chose to collect on the form.
  builtinColumns: Record<string, BuiltinColumnValue>;
  // Custom answers, keyed by OnboardingField.key — null when none.
  applicationData: Record<string, ExtraValue> | null;
  sponsor: { id: string; referralCode: string } | null;
};

export type ResolveMemberSignupResult =
  | { ok: true; resolved: ResolvedMemberSignup }
  | { ok: false; error: string; field?: "contributionAmount" };

export async function resolveMemberSignup(args: {
  fund: SignupFund;
  builtins: BuiltinSignupInput;
  applicationData: Record<string, ExtraValue> | undefined;
  referralCode: string | null | undefined;
  t: SignupTranslate;
}): Promise<ResolveMemberSignupResult> {
  const { fund, builtins, t } = args;

  // Commitment amount only applies to FIXED_PERIOD funds with tiers — ignore a
  // submitted value otherwise (the field isn't shown, but don't trust that).
  // The id set doubles as the allowlist for a submitted tierId builtin answer
  // below — a live, non-archived tier of THIS fund, same rule as the admin
  // tier picker (services/member/admin-tier-actions.ts).
  const liveTiers = await prisma.allocationTier.findMany({
    where: { fundId: fund.id, archivedAt: null },
    select: { id: true, hiddenAtSignup: true, minContribution: true },
  });
  // The allowlist is the signup-VISIBLE subset (issue #37) — a tier hidden from
  // the picker must also be rejected when named directly, or hiding it would be
  // cosmetic. The contribution check below still counts every live tier: hiding
  // a tier from applicants doesn't change whether the fund runs on tiers.
  const liveTierIds = new Set(
    liveTiers.filter((tier) => !tier.hiddenAtSignup).map((tier) => tier.id),
  );
  const contributionAmount = contributionApplies(fund.allocationMode, liveTiers.length)
    ? builtins.contributionAmount || null
    : null;

  // Filter answers to keys that exist on the fund's onboarding form, and
  // enforce the `required` flag for each. Anything unknown is dropped
  // (defensive against client tampering).
  //
  // Fields carrying a `builtinKey` are split off here: their answers belong in
  // typed Member columns, not in the applicationData blob, so that an address
  // collected at signup is the same address the email templates and tier
  // assignment read. See services/member/builtin-fields.ts.
  const fields = await prisma.onboardingField.findMany({
    where: { fundId: fund.id, target: "MEMBER", archivedAt: null },
    select: {
      key: true,
      label: true,
      required: true,
      builtinKey: true,
      visibleIf: true,
    },
  });
  const incoming = args.applicationData ?? {};
  const filtered: Record<string, ExtraValue> = {};
  const builtinColumns: Record<string, BuiltinColumnValue> = {};
  for (const field of fields) {
    const value = incoming[field.key];
    // A field hidden by its own visibleIf rule (dependency unanswered / not
    // yet satisfying the comparison) is neither required nor stored — a
    // stale answer left over from before the visitor's dependency answer
    // changed shouldn't persist. `visibleIf.fieldKey` only ever references
    // another custom field (enforced at save time), so `incoming` alone —
    // not the typed builtins — is the right lookup source.
    if (!isFieldVisible(parseVisibleIf(field.visibleIf), incoming)) continue;
    if (field.required && isExtraEmpty(value)) {
      return {
        ok: false,
        error: t("members.signup.errors.fieldRequired", { label: field.label }),
      };
    }
    if (isExtraEmpty(value)) continue;

    if (field.builtinKey && isMemberBuiltinKey(field.builtinKey)) {
      const coerced = coerceBuiltinValue(field.builtinKey, value);
      if (!coerced.ok) {
        return {
          ok: false,
          error: t("members.signup.errors.fieldInvalid", { label: field.label }),
        };
      }
      // A null here means "answered blank"; leave the column at its default
      // rather than writing null over a non-nullable count.
      if (coerced.value !== null) {
        // coerceBuiltinValue only checks the answer's shape (builtin-fields.ts
        // has no Prisma access) — for tierId specifically, confirm it names a
        // tier this fund actually has live today, so a tampered id can't
        // link a member to another fund's tier (or an archived one).
        if (field.builtinKey === "tierId" && !liveTierIds.has(coerced.value)) {
          return {
            ok: false,
            error: t("members.signup.errors.fieldInvalid", { label: field.label }),
          };
        }
        builtinColumns[field.builtinKey] = coerced.value;
      }
      continue;
    }

    filtered[field.key] = normalizeExtra(value!);
  }

  // The commitment amount can arrive two ways: the legacy hardcoded input
  // (builtins, gated above) or the admin-configured builtin field (issue
  // #179 — lands in builtinColumns like every other builtin). The builtin
  // answer honours the same FIXED_PERIOD-with-tiers gate: a fund that keeps
  // the field configured after dropping tiers shouldn't store a meaningless
  // value.
  if (
    builtinColumns.contributionAmount !== undefined &&
    !contributionApplies(fund.allocationMode, liveTiers.length)
  ) {
    delete builtinColumns.contributionAmount;
  }
  const effectiveContribution =
    typeof builtinColumns.contributionAmount === "string"
      ? builtinColumns.contributionAmount
      : contributionAmount;

  // A committed amount below the chosen tier's floor blocks the signup
  // (issue #158) — same rule the admin/member edit paths already enforce.
  // Only checkable when the fund's form collects a tier (builtin tierId,
  // #157); with no tier chosen there is no floor, and an empty amount
  // defaults to the tier target which is ≥ the floor by definition.
  const chosenTier =
    typeof builtinColumns.tierId === "string"
      ? liveTiers.find((tier) => tier.id === builtinColumns.tierId)
      : undefined;
  if (
    effectiveContribution !== null &&
    chosenTier &&
    isBelowTierMinimum(
      Number(effectiveContribution),
      Number(chosenTier.minContribution),
    )
  ) {
    return {
      ok: false,
      error: t("members.signup.errors.amountBelowTierMin", {
        min: chosenTier.minContribution.toString(),
      }),
      field: "contributionAmount",
    };
  }

  // Resolve the referral code if any. Soft-fail on invalid / self-referral —
  // the code came from a hidden URL param the visitor never saw, so showing
  // an error would be confusing.
  let sponsor: { id: string; referralCode: string } | null = null;
  if (args.referralCode) {
    const found = await prisma.member.findFirst({
      where: { fundId: fund.id, referralCode: args.referralCode },
      select: { id: true, referralCode: true, email: true, status: true },
    });
    if (
      found &&
      found.referralCode &&
      found.email !== builtins.email &&
      found.status !== "STOPPED"
    ) {
      sponsor = { id: found.id, referralCode: found.referralCode };
    }
  }

  return {
    ok: true,
    resolved: {
      contributionAmount,
      builtinColumns,
      applicationData: Object.keys(filtered).length > 0 ? filtered : null,
      sponsor,
    },
  };
}

function isExtraEmpty(value: ExtraValue | undefined): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "boolean") return value === false;
  return false;
}

function normalizeExtra(value: ExtraValue): ExtraValue {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return value.map((v) => v.trim()).filter(Boolean);
  return value;
}

/** Prisma P2002 on a unique that includes `field` (e.g. paymentReference, email). */
export function isUniqueViolationOn(e: unknown, field: string): boolean {
  if (!(e instanceof Error) || !("code" in e)) return false;
  if ((e as { code?: string }).code !== "P2002") return false;
  const meta = (e as { meta?: { target?: unknown } }).meta;
  if (!meta?.target) return false;
  const target = Array.isArray(meta.target) ? meta.target : [meta.target];
  return target.some((t) => typeof t === "string" && t.includes(field));
}
