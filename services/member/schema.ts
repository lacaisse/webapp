import { z } from "zod";

// Built-in signup fields per the choice in design: only firstName / lastName
// / email are hardcoded in the form. Custom fields (any per-fund extras)
// live in OnboardingField rows and are validated server-side against their
// definitions; on the client they pass through as a record of strings.

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

export const SignupFormSchema = BuiltinSignupSchema.extend({
  extras: z.record(z.string(), z.string()).optional(),
});

export type BuiltinSignupInput = z.infer<typeof BuiltinSignupSchema>;
export type SignupFormInput = z.infer<typeof SignupFormSchema>;
