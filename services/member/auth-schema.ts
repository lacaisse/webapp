// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";

import { PASSWORD_MIN_LENGTH } from "@/app/(auth-host)/schemas";

import { BuiltinSignupSchema, ExtraValueSchema } from "./schema";

// Member login forms (app/(fund-member)). Same key-as-message convention as
// the staff auth schemas: forms resolve the key with the root translator.

export { PASSWORD_MIN_LENGTH };

export const MemberPasswordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, { error: "auth.errors.passwordMin" });

/** The /signup form: the /join builtins plus a password (confirmed). */
export const MemberSignupFormSchema = BuiltinSignupSchema.extend({
  password: MemberPasswordSchema,
  confirmPassword: z.string(),
  extras: z.record(z.string(), ExtraValueSchema).optional(),
}).refine((d) => d.password === d.confirmPassword, {
  error: "auth.errors.passwordsDontMatch",
  path: ["confirmPassword"],
});
export type MemberSignupFormInput = z.infer<typeof MemberSignupFormSchema>;

/** What the server action receives (the form splits extras off itself). */
export const MemberSignupInputSchema = z.object({
  builtins: BuiltinSignupSchema,
  password: MemberPasswordSchema,
  applicationData: z.record(z.string(), ExtraValueSchema).optional(),
  referralCode: z.string().nullable().optional(),
});
export type MemberSignupInput = z.infer<typeof MemberSignupInputSchema>;

export const MemberLoginSchema = z.object({
  email: z.email({ error: "auth.errors.emailInvalid" }),
  password: z.string().min(1, { error: "auth.errors.passwordRequired" }),
});
export type MemberLoginInput = z.infer<typeof MemberLoginSchema>;

export const MemberForgotSchema = z.object({
  email: z.email({ error: "auth.errors.emailInvalid" }),
});
export type MemberForgotInput = z.infer<typeof MemberForgotSchema>;

export const MemberResetSchema = z
  .object({
    password: MemberPasswordSchema,
    confirmPassword: z.string(),
  })
  .refine((d) => d.password === d.confirmPassword, {
    error: "auth.errors.passwordsDontMatch",
    path: ["confirmPassword"],
  });
export type MemberResetInput = z.infer<typeof MemberResetSchema>;
