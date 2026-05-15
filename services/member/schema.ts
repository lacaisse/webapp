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
