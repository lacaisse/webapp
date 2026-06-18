// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";

// Built-in signup fields per the choice in design: only firstName / lastName
// / email are hardcoded in the form. Custom fields (any per-fund extras)
// live in OnboardingField rows; their values are validated server-side
// against the field type. On the wire each extra can be a string, a string
// array (MULTISELECT), or a boolean (CHECKBOX).

export const NAME_MIN_LENGTH = 1;

export const BuiltinSignupSchema = z.object({
  firstName: z.string().min(NAME_MIN_LENGTH, {
    error: "members.signup.errors.firstNameRequired",
  }),
  lastName: z.string().min(NAME_MIN_LENGTH, {
    error: "members.signup.errors.lastNameRequired",
  }),
  email: z.string().email({ error: "members.signup.errors.emailInvalid" }),
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
