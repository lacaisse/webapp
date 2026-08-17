// SPDX-License-Identifier: AGPL-3.0-or-later

// Renders a stored `applicationData` answer back to admin-facing text.
//
// SELECT/MULTISELECT fields store the option's `value` (e.g. "value1"), not
// its `label` (e.g. "75 €") — the same split the public form and the extras
// schema already rely on. A raw value with no matching option (renamed or
// removed since the answer was submitted) falls back to the stored value
// rather than disappearing.
//
// Pure module (no Prisma, no server-only) so it can be shared by every
// read-only "application data" display (member + merchant detail pages).

export type AnswerFieldType =
  | "TEXT"
  | "TEXTAREA"
  | "EMAIL"
  | "PHONE"
  | "NUMBER"
  | "SELECT"
  | "MULTISELECT"
  | "CHECKBOX"
  | "DATE";

export type AnswerField = {
  type: AnswerFieldType;
  options: { value: string; label: string }[];
};

function resolveOptionLabel(value: unknown, options: AnswerField["options"]): string {
  const raw = String(value);
  return options.find((o) => o.value === raw)?.label ?? raw;
}

export function formatOnboardingAnswer(
  value: unknown,
  field: AnswerField | undefined,
): string {
  if (value === null || value === undefined || value === "") return "—";

  if (field?.type === "SELECT") {
    return resolveOptionLabel(value, field.options);
  }

  if (field?.type === "MULTISELECT" && Array.isArray(value)) {
    return value.map((v) => resolveOptionLabel(v, field.options)).join(", ");
  }

  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
