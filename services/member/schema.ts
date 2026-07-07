// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";

// Built-in signup fields per the choice in design: only firstName / lastName
// / email are hardcoded in the form. Custom fields (any per-fund extras)
// live in OnboardingField rows; their values are validated server-side
// against the field type. On the wire each extra can be a string, a string
// array (MULTISELECT), or a boolean (CHECKBOX).

export const NAME_MIN_LENGTH = 1;

// A euro amount as a string: whole number with up to 2 decimals. Empty string
// is allowed and means "unset" (the caller normalises it to null). Mirrors the
// tier DecimalString pattern in services/allocation-tiers/admin-actions.ts.
const OptionalMoney = (errorKey: string) =>
  z
    .union([
      z.literal(""),
      z.string().trim().regex(/^\d+(\.\d{1,2})?$/, { error: errorKey }),
    ])
    .optional();

export const BuiltinSignupSchema = z.object({
  firstName: z.string().min(NAME_MIN_LENGTH, {
    error: "members.signup.errors.firstNameRequired",
  }),
  lastName: z.string().min(NAME_MIN_LENGTH, {
    error: "members.signup.errors.lastNameRequired",
  }),
  email: z.string().email({ error: "members.signup.errors.emailInvalid" }),
  // Opt out of payment-reminder emails at registration (issue #39/#40).
  // Persists to Member.emailUnsubscribed; the member can flip it later via the
  // deregistration link. Defaults to opted-in.
  remindersOptOut: z.boolean().optional(),
  // The amount the member commits to contribute (issue #82). Optional at
  // signup — there's no tier yet to floor it against, so it's a free amount
  // here; an admin can adjust once a tier is assigned. Empty → null (use the
  // tier target). See services/member/contribution.ts.
  contributionAmount: OptionalMoney("members.signup.errors.amountInvalid"),
});

// Admin-side edit of a member's core record from the detail view. Identity
// fields reuse the signup rules; the rest are free-form optionals that the
// action normalises (empty string → null). Tier and status have their own
// dedicated controls and are intentionally not part of this form.
const OptionalText = z
  .string()
  .trim()
  .max(500, { error: "members.admin.edit.errors.tooLong" })
  .optional();

export const EditMemberProfileSchema = z.object({
  firstName: z.string().trim().min(NAME_MIN_LENGTH, {
    error: "members.signup.errors.firstNameRequired",
  }),
  lastName: z.string().trim().min(NAME_MIN_LENGTH, {
    error: "members.signup.errors.lastNameRequired",
  }),
  email: z.string().trim().email({ error: "members.signup.errors.emailInvalid" }),
  phone: OptionalText,
  address: OptionalText,
  postalCode: OptionalText,
  city: OptionalText,
  iban: OptionalText,
  notes: OptionalText,
  householdAdults: z.coerce
    .number({ error: "members.admin.edit.errors.householdInvalid" })
    .int({ error: "members.admin.edit.errors.householdInvalid" })
    .min(0, { error: "members.admin.edit.errors.householdInvalid" })
    .max(50, { error: "members.admin.edit.errors.householdInvalid" }),
  householdChildren: z.coerce
    .number({ error: "members.admin.edit.errors.householdInvalid" })
    .int({ error: "members.admin.edit.errors.householdInvalid" })
    .min(0, { error: "members.admin.edit.errors.householdInvalid" })
    .max(50, { error: "members.admin.edit.errors.householdInvalid" }),
  // Committed contribution amount (issue #82). Empty → null (use the tier
  // target). The tier-minimum floor is enforced server-side in the action,
  // where the member's current tier is known. See contribution.ts.
  contributionAmount: OptionalMoney("members.admin.edit.errors.amountInvalid"),
});

export type EditMemberProfileInput = z.infer<typeof EditMemberProfileSchema>;

export const ExtraValueSchema = z.union([
  z.string(),
  z.array(z.string()),
  z.boolean(),
]);

export type ExtraValue = z.infer<typeof ExtraValueSchema>;

export const SignupFormSchema = BuiltinSignupSchema.extend({
  extras: z.record(z.string(), ExtraValueSchema).optional(),
});

export type BuiltinSignupInput = z.infer<typeof BuiltinSignupSchema>;
export type SignupFormInput = z.infer<typeof SignupFormSchema>;
