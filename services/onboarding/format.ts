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
//
// Localization is INJECTED rather than imported: CHECKBOX answers are stored
// as booleans and DATE answers as bare `yyyy-mm-dd` strings, neither of which
// is readable as-is, but pulling next-intl in here would make the module
// server-only and untestable in isolation. Callers (both server components,
// both already holding `getTranslations`/`getFormatter`) pass an
// `AnswerFormatters` instead. Omitting it keeps the raw rendering, so the
// helper stays usable — and unit-testable — without an intl context.

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

export type AnswerFormatters = {
  // Rendered for CHECKBOX answers (and any stray boolean) — e.g. Oui / Non.
  boolean: (value: boolean) => string;
  // Rendered for a DATE answer. Only ever called with a well-formed
  // `yyyy-mm-dd` string that parses to a real date; anything else falls back
  // to the stored text so a malformed answer stays visible rather than
  // rendering as "Invalid Date".
  date: (value: string) => string;
};

// The shape a DATE field's `<input type="date">` produces. Mirrors the guard
// in services/member/prefill.ts, which drops anything else rather than
// prefilling a value the input would render blank.
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function resolveOptionLabel(
  value: unknown,
  options: AnswerField["options"],
): string {
  const raw = String(value);
  return options.find((o) => o.value === raw)?.label ?? raw;
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined || value === "") return true;
  // An emptied MULTISELECT is stored as `[]` by mergeApplicationData's
  // normaliser only in legacy blobs (it deletes the key today) — either way
  // it reads as "unanswered", not as a blank cell.
  return Array.isArray(value) && value.length === 0;
}

export function formatOnboardingAnswer(
  value: unknown,
  field: AnswerField | undefined,
  formatters?: AnswerFormatters,
): string {
  if (isEmpty(value)) return "—";

  if (field?.type === "SELECT") {
    return resolveOptionLabel(value, field.options);
  }

  if (field?.type === "MULTISELECT") {
    // Normally an array, but a single-answer blob (or a hand-edited import)
    // can hold a lone string — resolve it rather than dropping through to the
    // raw-value branch below.
    if (Array.isArray(value)) {
      return value.map((v) => resolveOptionLabel(v, field.options)).join(", ");
    }
    if (typeof value === "string") {
      return resolveOptionLabel(value, field.options);
    }
  }

  // CHECKBOX answers are booleans; guard on the value too so a legacy blob
  // whose field definition has since changed type still reads as yes/no.
  if (typeof value === "boolean") {
    return formatters ? formatters.boolean(value) : String(value);
  }

  if (field?.type === "DATE" && typeof value === "string") {
    const trimmed = value.trim();
    if (formatters && ISO_DATE.test(trimmed)) {
      const parsed = new Date(trimmed);
      if (!Number.isNaN(parsed.getTime())) return formatters.date(trimmed);
    }
    return trimmed;
  }

  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
