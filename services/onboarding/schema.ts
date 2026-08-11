import { z } from "zod";

// Shared schema for onboarding field CRUD. Lives outside admin-actions.ts
// so it can be imported by client components (a "use server" file can
// only export async functions).

const FieldOptionSchema = z.object({
  value: z.string().min(1, { error: "onboardingFields.errors.optionEmpty" }),
  label: z.string().min(1, { error: "onboardingFields.errors.optionEmpty" }),
});

export type FieldOption = z.infer<typeof FieldOptionSchema>;

const fieldShape = {
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
  label: z.string().min(1, { error: "onboardingFields.errors.labelRequired" }),
  helpText: z.string().nullable().optional(),
  required: z.boolean().default(false),
  position: z.number().int().min(0).default(0),
  // Which step of the form this field appears on. Null / omitted = the
  // first step. The action verifies the step belongs to the same fund and
  // target before saving.
  stepId: z.string().nullable().optional(),
  // Set to collect a typed Member column instead of a custom
  // `applicationData` entry. The action validates it against the built-in
  // registry and forces `key` and `type` to match, so a client can't pair
  // an arbitrary key or input type with a real column.
  builtinKey: z.string().nullable().optional(),
  options: z.array(FieldOptionSchema).optional(),
};

const optionsRequiredRefinement = (v: { type: string; options?: FieldOption[] }) =>
  v.type !== "SELECT" && v.type !== "MULTISELECT"
    ? true
    : (v.options?.length ?? 0) > 0;
const optionsRequiredRefinementOpts = {
  error: "onboardingFields.errors.optionsRequired",
  path: ["options"] as PropertyKey[],
};

export const FieldDataSchema = z
  .object({
    key: z
      .string()
      .min(1, { error: "onboardingFields.errors.keyRequired" })
      .regex(/^[a-z][a-z0-9_]*$/, {
        error: "onboardingFields.errors.keyInvalid",
      }),
    ...fieldShape,
  })
  .refine(optionsRequiredRefinement, optionsRequiredRefinementOpts);

export type FieldData = z.infer<typeof FieldDataSchema>;

// Keys are immutable after creation (see admin-actions.ts) — the update
// action parses with this schema instead, which still requires a key to be
// present but doesn't re-enforce the create-time format rule. Older fields
// (e.g. ones migrated from a typed Member column) can carry a key that
// predates the current format rule, and editing their label/position/etc
// shouldn't fail just because the client echoes that key back unchanged.
export const FieldUpdateDataSchema = z
  .object({
    key: z.string().min(1, { error: "onboardingFields.errors.keyRequired" }),
    ...fieldShape,
  })
  .refine(optionsRequiredRefinement, optionsRequiredRefinementOpts);

export type OnboardingFieldResult =
  | { ok: true }
  | { error: string; field?: keyof FieldData };

// --- Steps -----------------------------------------------------------------
// A step is one page of the public signup form. Title/description are
// admin-authored free text in the fund's own language, not i18n keys.

export const StepDataSchema = z.object({
  title: z.string().trim().min(1, { error: "onboardingSteps.errors.titleRequired" }),
  description: z.string().trim().nullable().optional(),
  position: z.number().int().min(0).default(0),
});

export type StepData = z.infer<typeof StepDataSchema>;

export type OnboardingStepResult =
  | { ok: true }
  | { error: string; field?: keyof StepData };
