// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";
import { PASSWORD_MIN_LENGTH } from "@/app/(auth-host)/schemas";

// Re-export so the client form imports the constant from one place (it drives
// both validation and the {min} interpolation in the translated message).
export { PASSWORD_MIN_LENGTH };

// Same key-as-message convention as the auth-host schemas: forms call t() at
// display time. Shared between the client form (zodResolver) and the server
// action (re-validation — never trust the client).
export const ChangePasswordSchema = z
  .object({
    currentPassword: z
      .string()
      .min(1, { error: "auth.errors.passwordRequired" }),
    newPassword: z
      .string()
      .min(PASSWORD_MIN_LENGTH, { error: "auth.errors.passwordMin" }),
    confirmPassword: z.string(),
  })
  .refine((d) => d.newPassword === d.confirmPassword, {
    error: "auth.errors.passwordsDontMatch",
    path: ["confirmPassword"],
  });
export type ChangePasswordInput = z.infer<typeof ChangePasswordSchema>;
