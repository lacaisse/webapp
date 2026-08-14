import { z } from "zod";

import { VisibleIfSchema } from "./visibility";

// Shared schema for onboarding field CRUD. Lives outside admin-actions.ts
// so it can be imported by client components (a "use server" file can
// only export async functions).

const FieldOptionSchema = z.object({
  value: z.string().min(1, { error: "onboardingFields.errors.optionEmpty" }),
  label: z.string().min(1, { error: "onboardingFields.errors.optionEmpty" }),
});

export type FieldOption = z.infer<typeof FieldOptionSchema>;

// Key validation applies to NEW keys only. `key` is immutable after creation
// (see admin-actions.ts), so re-running this regex against an unchanged,
// already-stored key on every edit would reject legitimate rows the moment
// the rule tightens — which is exactly what broke editing the pre-existing
// `householdAdults` / `householdChildren` fields (camelCase, seeded before
// this lowercase-only rule existed). `FieldDataObjectSchema` carries the
// field so `create` can validate it; `UpdateFieldDataSchema` omits it
// entirely so `update` neither validates nor accepts a new value for it.
const FieldDataObjectSchema = z.object({
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
  // Show (and require) this field only when another custom field's answer
  // satisfies a comparison — e.g. `householdincome` only when
  // `householdAdults` > 1. null/omitted = always shown. The action resolves
  // and validates `fieldKey` against this fund's other fields.
  visibleIf: VisibleIfSchema.nullable().optional(),
});

const optionsRequiredRefinement = {
  check: (v: { type: string; options?: FieldOption[] }) =>
    v.type !== "SELECT" && v.type !== "MULTISELECT"
      ? true
      : (v.options?.length ?? 0) > 0,
  message: {
    error: "onboardingFields.errors.optionsRequired",
    path: ["options"],
  },
};

export const FieldDataSchema = FieldDataObjectSchema.refine(
  optionsRequiredRefinement.check,
  optionsRequiredRefinement.message,
);

// Used by `updateOnboardingFieldAction`: same shape minus `key`, which is
// immutable and therefore never validated (or accepted) on edit.
export const UpdateFieldDataSchema = FieldDataObjectSchema.omit({
  key: true,
}).refine(optionsRequiredRefinement.check, optionsRequiredRefinement.message);

export type FieldData = z.infer<typeof FieldDataSchema>;

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
