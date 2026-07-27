// SPDX-License-Identifier: AGPL-3.0-or-later

// Built-in Member attributes a fund can choose to ask for on the public signup
// form.
//
// These already exist as typed columns on Member — admins can edit them on the
// detail page and CSV import maps them — but until now the public form was
// hardcoded to first name / last name / email. A fund that wanted an address
// had to add a *custom* field, which stored the answer in the
// `applicationData` JSON blob. Same data, wrong column, and silently so: the
// postal-address line in services/email/templates.ts reads `Member.address`,
// and tier assignment reads the household counts, so neither would ever see a
// value that landed in JSON.
//
// An OnboardingField with `builtinKey` set is rendered, ordered, grouped into
// steps, prefilled and validated exactly like any custom field. The ONLY
// difference is where the answer is written at the end of signup.
//
// Excluded on purpose:
//   - `notes`  — admin-internal commentary, not something to ask an applicant.
//   - `locale` — captured automatically from the request locale at signup.
//
// Pure module (no Prisma, no server-only) so it can be unit-tested and shared
// with client components.

export type MemberBuiltinKey =
  | "phone"
  | "address"
  | "postalCode"
  | "city"
  | "iban"
  | "householdAdults"
  | "householdChildren";

// The input type is fixed by the column — an admin picking "Household adults"
// can't choose to render it as a checkbox. Label, help text, required,
// position and step assignment all stay editable, which is the part that
// actually varies per fund.
export type BuiltinFieldDef = {
  key: MemberBuiltinKey;
  type: "TEXT" | "PHONE" | "NUMBER";
  // Suggested label offered in the admin picker; the admin can overwrite it.
  labelKey: string;
};

export const MEMBER_BUILTIN_FIELDS: BuiltinFieldDef[] = [
  { key: "phone", type: "PHONE", labelKey: "members.builtinFields.phone" },
  { key: "address", type: "TEXT", labelKey: "members.builtinFields.address" },
  { key: "postalCode", type: "TEXT", labelKey: "members.builtinFields.postalCode" },
  { key: "city", type: "TEXT", labelKey: "members.builtinFields.city" },
  { key: "iban", type: "TEXT", labelKey: "members.builtinFields.iban" },
  {
    key: "householdAdults",
    type: "NUMBER",
    labelKey: "members.builtinFields.householdAdults",
  },
  {
    key: "householdChildren",
    type: "NUMBER",
    labelKey: "members.builtinFields.householdChildren",
  },
];

const BY_KEY = new Map(MEMBER_BUILTIN_FIELDS.map((f) => [f.key, f]));

export function getBuiltinField(key: string): BuiltinFieldDef | null {
  return BY_KEY.get(key as MemberBuiltinKey) ?? null;
}

export function isMemberBuiltinKey(key: string): key is MemberBuiltinKey {
  return BY_KEY.has(key as MemberBuiltinKey);
}

// Matches the bounds EditMemberProfileSchema enforces for the admin-side edit,
// so a member can't arrive through signup in a state the admin form would
// reject.
const HOUSEHOLD_MAX = 50;
const TEXT_MAX_LENGTH = 500;

export type BuiltinColumnValue = string | number | null;

export type CoerceResult =
  | { ok: true; value: BuiltinColumnValue }
  | { ok: false };

// Turn a form answer into something the typed column accepts. Returns
// `{ ok: false }` for input the column can't hold — the caller surfaces that
// as a validation error rather than silently dropping it, since unlike
// prefill this value was typed by the applicant on purpose.
export function coerceBuiltinValue(
  key: MemberBuiltinKey,
  raw: unknown,
): CoerceResult {
  const def = BY_KEY.get(key);
  if (!def) return { ok: false };

  // Checkboxes and multi-selects have no built-in column that accepts them.
  if (typeof raw === "boolean" || Array.isArray(raw)) return { ok: false };

  const text = raw == null ? "" : String(raw).trim();

  if (def.type === "NUMBER") {
    // Empty means "not answered" — the column keeps its Prisma default rather
    // than being forced to 0, which would read as a real answer.
    if (text === "") return { ok: true, value: null };
    if (!/^\d+$/.test(text)) return { ok: false };
    const n = Number.parseInt(text, 10);
    if (!Number.isFinite(n) || n < 0 || n > HOUSEHOLD_MAX) return { ok: false };
    return { ok: true, value: n };
  }

  if (text === "") return { ok: true, value: null };
  if (text.length > TEXT_MAX_LENGTH) return { ok: false };
  return { ok: true, value: text };
}
