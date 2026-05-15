// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";

// Schemas emit translation KEYS as their error messages — forms call t() at
// display time. Constraint values used by the messages (e.g. password min
// length) are exported so the same constants drive validation AND
// interpolation in t().

export const PASSWORD_MIN_LENGTH = 8;

export const LoginSchema = z.object({
  email: z.email({ error: "auth.errors.emailInvalid" }),
  password: z.string().min(1, { error: "auth.errors.passwordRequired" }),
});
export type LoginInput = z.infer<typeof LoginSchema>;

export const SignupSchema = z.object({
  email: z.email({ error: "auth.errors.emailInvalid" }),
  password: z
    .string()
    .min(PASSWORD_MIN_LENGTH, { error: "auth.errors.passwordMin" }),
});
export type SignupInput = z.infer<typeof SignupSchema>;

export const ForgotPasswordSchema = z.object({
  email: z.email({ error: "auth.errors.emailInvalid" }),
});
export type ForgotPasswordInput = z.infer<typeof ForgotPasswordSchema>;

export const ResetPasswordSchema = z
  .object({
    password: z
      .string()
      .min(PASSWORD_MIN_LENGTH, { error: "auth.errors.passwordMin" }),
    confirmPassword: z.string(),
  })
  .refine((d) => d.password === d.confirmPassword, {
    error: "auth.errors.passwordsDontMatch",
    path: ["confirmPassword"],
  });
export type ResetPasswordInput = z.infer<typeof ResetPasswordSchema>;
