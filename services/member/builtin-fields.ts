// SPDX-License-Identifier: AGPL-3.0-or-later

// The member attributes that remain typed columns AND can be asked for on the
// public signup form: the postal address.
//
// Everything a fund collects beyond the base identity (first name, last name,
// email) is a custom question stored in `applicationData`. The postal address
// is the exception, because it is not just stored — `formatMemberAddress` in
// services/email/templates.ts composes it into the `{address}` placeholder
// that card-assigned emails and template previews render. A value sitting in
// the JSON blob would never reach that.
//
// An OnboardingField with `builtinKey` set is rendered, ordered, grouped into
// steps, prefilled and validated exactly like any custom field. The ONLY
// difference is where the answer is written at the end of signup.
//
// Not here, and deliberately so:
//   - phone, iban, householdAdults, householdChildren — moved to custom
//     questions; no code reads them (the EPC QR uses the FUND's banking IBAN,
//     and bank-sync matches through LinkedBankAccount).
//   - contributionAmount — assigned by admins / commitment flows, not asked.
//   - notes  — admin-internal commentary, not something to ask an applicant.
//   - locale — captured automatically from the request locale at signup.
//
// tierId IS here (issue #157): a fund can let applicants pick their own
// allocation tier at signup. Its options are never admin-typed free text —
// they're the fund's live, non-archived AllocationTier rows — so this module
// only validates the *shape* of the answer (a non-blank id, or blank). The
// caller (services/member/actions.ts) is the one with Prisma access, so it's
// the one that checks the submitted id actually names a real tier of this
// fund before writing it to Member.tierId.
//
// Pure module (no Prisma, no server-only) so it can be unit-tested and shared
// with client components.

export type MemberBuiltinKey = "address" | "postalCode" | "city" | "tierId";

// The input type is fixed by the column — an admin picking "City" can't choose
// to render it as a checkbox. Label, help text, required, position and step
// assignment all stay editable, which is the part that actually varies per
// fund. The three address parts are free text; tierId is a select whose
// options are resolved dynamically (not stored in OnboardingField.config, and
// not editable by the admin — see the issue's "it doesn't need to be
// customizable").
export type BuiltinFieldDef = {
  key: MemberBuiltinKey;
  type: "TEXT" | "SELECT";
  // Suggested label offered in the admin picker; the admin can overwrite it.
  labelKey: string;
};

export const MEMBER_BUILTIN_FIELDS: BuiltinFieldDef[] = [
  { key: "address", type: "TEXT", labelKey: "members.builtinFields.address" },
  { key: "postalCode", type: "TEXT", labelKey: "members.builtinFields.postalCode" },
  { key: "city", type: "TEXT", labelKey: "members.builtinFields.city" },
  { key: "tierId", type: "SELECT", labelKey: "members.builtinFields.tier" },
];

const BY_KEY = new Map(MEMBER_BUILTIN_FIELDS.map((f) => [f.key, f]));

export function getBuiltinField(key: string): BuiltinFieldDef | null {
  return BY_KEY.get(key as MemberBuiltinKey) ?? null;
}

export function isMemberBuiltinKey(key: string): key is MemberBuiltinKey {
  return BY_KEY.has(key as MemberBuiltinKey);
}

// Matches the bound EditMemberProfileSchema enforces for the admin-side edit,
// so a member can't arrive through signup in a state the admin form would
// reject.
const TEXT_MAX_LENGTH = 500;

export type BuiltinColumnValue = string | null;

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
  if (!BY_KEY.has(key)) return { ok: false };

  // Checkboxes and multi-selects have no built-in column that accepts them.
  if (typeof raw === "boolean" || Array.isArray(raw)) return { ok: false };

  const text = raw == null ? "" : String(raw).trim();

  // Blank means "not answered" — store null rather than an empty string so
  // formatMemberAddress skips the part instead of emitting a stray comma.
  if (text === "") return { ok: true, value: null };
  if (text.length > TEXT_MAX_LENGTH) return { ok: false };
  return { ok: true, value: text };
}
