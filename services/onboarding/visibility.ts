// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";

// Optional conditional-visibility rule for an OnboardingField: "only show
// (and only require) this field when another field's answer satisfies a
// comparison." E.g. show `householdincome` only when `householdAdults` > 1.
//
// Scoped deliberately: `fieldKey` may only reference another CUSTOM field of
// the same fund + target (never a built-in). Built-ins are collected via
// separate form inputs (services/member/builtin-fields.ts) whose values never
// land in the `applicationData` blob this evaluates against, so a built-in
// dependency could never be resolved. See admin-actions.ts for the check.
//
// Pure module (no Prisma, no server-only) so it can run identically on the
// client (hide/show as the visitor types) and the server (the actual
// enforcement — see services/member/actions.ts, services/merchant/actions.ts).

export const VISIBLE_IF_OPERATORS = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
] as const;

export type VisibleIfOperator = (typeof VISIBLE_IF_OPERATORS)[number];

// Only "eq"/"neq" make sense against a non-numeric answer (text, select,
// checkbox); the ordering operators require the dependency to be a NUMBER
// field, enforced in admin-actions.ts at save time.
export const NUMERIC_ONLY_OPERATORS: VisibleIfOperator[] = [
  "gt",
  "gte",
  "lt",
  "lte",
];

export const VisibleIfSchema = z.object({
  fieldKey: z.string().min(1),
  operator: z.enum(VISIBLE_IF_OPERATORS),
  value: z.string().min(1, {
    error: "onboardingFields.errors.visibleIfValueRequired",
  }),
});

export type VisibleIf = z.infer<typeof VisibleIfSchema>;

// Best-effort parse of a Prisma `Json` column back into a VisibleIf — malformed
// or legacy-null data degrades to "no condition" (field always visible) rather
// than throwing, since this runs on every render of the public form.
export function parseVisibleIf(raw: unknown): VisibleIf | null {
  if (raw === null || raw === undefined) return null;
  const parsed = VisibleIfSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// Renders a submitted answer (whatever shape the field type produced) to the
// plain string form comparisons run against.
function answerToString(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return value.map(String).join(",");
  return String(value).trim();
}

// Evaluates whether a field should be shown (and, when required, enforced)
// given the current set of answers keyed by field key. No rule = always
// visible. An unanswered or non-numeric dependency fails a numeric comparison
// rather than throwing — an unmet condition just means "not visible yet".
export function isFieldVisible(
  visibleIf: VisibleIf | null | undefined,
  answers: Record<string, unknown>,
): boolean {
  if (!visibleIf) return true;
  const actual = answerToString(answers[visibleIf.fieldKey]);
  const expected = visibleIf.value;

  if (visibleIf.operator === "eq") return actual === expected;
  if (visibleIf.operator === "neq") return actual !== expected;

  const a = Number(actual);
  const e = Number(expected);
  if (actual === "" || Number.isNaN(a) || Number.isNaN(e)) return false;
  if (visibleIf.operator === "gt") return a > e;
  if (visibleIf.operator === "gte") return a >= e;
  if (visibleIf.operator === "lt") return a < e;
  return a <= e; // "lte" — the only operator left
}
