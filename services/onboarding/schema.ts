import { z } from "zod";

// Shared schema for onboarding field CRUD. Lives outside admin-actions.ts
// so it can be imported by client components (a "use server" file can
// only export async functions).

const FieldOptionSchema = z.object({
  value: z.string().min(1, { error: "onboardingFields.errors.optionEmpty" }),
  label: z.string().min(1, { error: "onboardingFields.errors.optionEmpty" }),
});

export type FieldOption = z.infer<typeof FieldOptionSchema>;

export const FieldDataSchema = z
  .object({
    key: z
      .string()
      .min(1, { error: "onboardingFields.errors.keyRequired" })
      .regex(/^[a-z][a-z0-9_]*$/, {
        error: "onboardingFields.errors.keyInvalid",
      }),
    type: z.enum([
      "TEXT",
      "TEXTAREA",
      "EMAIL",
      "PHONE",
      "NUMBER",
      "SELECT",
      "MULTISELECT",
      "CHECKBOX",
      "DATE",
    ]),
    label: z
      .string()
      .min(1, { error: "onboardingFields.errors.labelRequired" }),
    helpText: z.string().nullable().optional(),
    required: z.boolean().default(false),
    position: z.number().int().min(0).default(0),
    options: z.array(FieldOptionSchema).optional(),
  })
  .refine(
    (v) =>
      v.type !== "SELECT" && v.type !== "MULTISELECT"
        ? true
        : (v.options?.length ?? 0) > 0,
    {
      error: "onboardingFields.errors.optionsRequired",
      path: ["options"],
    },
  );

export type FieldData = z.infer<typeof FieldDataSchema>;

export type OnboardingFieldResult =
  | { ok: true }
  | { error: string; field?: keyof FieldData };
