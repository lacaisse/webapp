// SPDX-License-Identifier: AGPL-3.0-or-later

// Prefill for the public member signup form (/join).
//
// A fund's own website can link visitors here with what it already knows about
// them — `/join?firstName=Ada&email=ada@example.org&profession=engineer`. We
// map those params onto the form's initial values so the visitor doesn't
// retype them.
//
// Prefill is a CONVENIENCE, never a trust boundary. Every value stays editable
// and `signupMemberAction` re-validates the submission from scratch, exactly as
// it does for a hand-typed form. What this module does buy us is not letting
// obvious garbage reach the form state: a SELECT value that isn't one of the
// field's options, or a number that isn't a number, is dropped rather than
// rendered as a broken-looking pre-filled answer.
//
// Pure module (no Prisma, no server-only) so it can be unit-tested and shared.

export type PrefillFieldDef = {
  key: string;
  type:
    | "TEXT"
    | "TEXTAREA"
    | "EMAIL"
    | "PHONE"
    | "NUMBER"
    | "SELECT"
    | "MULTISELECT"
    | "CHECKBOX"
    | "DATE";
  options: { value: string; label: string }[];
};

export type PrefillValue = string | string[] | boolean;

export type SignupPrefill = {
  firstName: string;
  lastName: string;
  email: string;
  contributionAmount: string;
  extras: Record<string, PrefillValue>;
};

// Params that mean something else on this route and must never be read as
// form input. `ref` is the referral code (see signupMemberAction), `step` is
// the stepper's position, `error` is set when we bounce back from a failure.
const RESERVED_PARAMS = new Set(["ref", "step", "error"]);

// Built-in inputs the form always renders, addressable by their form name.
const BUILTIN_KEYS = [
  "firstName",
  "lastName",
  "email",
  "contributionAmount",
] as const;

// Generous but finite: long enough for an address or a short answer, short
// enough that a hostile link can't stuff megabytes into the form state.
const MAX_TEXT_LENGTH = 500;
const MAX_MULTISELECT_VALUES = 50;

// Accepts anything with a `get`: URLSearchParams, or the plain object Next
// hands a page's searchParams (values may be string | string[] | undefined).
export type RawParams =
  | URLSearchParams
  | Record<string, string | string[] | undefined>;

function readParam(params: RawParams, key: string): string | undefined {
  if (params instanceof URLSearchParams) {
    return params.get(key) ?? undefined;
  }
  const value = params[key];
  // Repeated params (?x=1&x=2) arrive as an array — take the first, since
  // every builtin and every non-MULTISELECT field is single-valued.
  if (Array.isArray(value)) return value[0];
  return value;
}

export function parseSignupPrefill(
  params: RawParams,
  fields: PrefillFieldDef[],
  options?: { showContribution?: boolean },
): SignupPrefill {
  const prefill: SignupPrefill = {
    firstName: "",
    lastName: "",
    email: "",
    contributionAmount: "",
    extras: {},
  };

  for (const key of BUILTIN_KEYS) {
    // The commitment amount input only exists on FIXED_PERIOD funds with
    // tiers. Prefilling a field the form won't render would smuggle a value
    // into the submission that the visitor never saw.
    if (key === "contributionAmount" && options?.showContribution === false) {
      continue;
    }
    const raw = readParam(params, key);
    if (raw === undefined) continue;
    const value =
      key === "contributionAmount"
        ? coerceAmount(raw)
        : truncate(raw.trim());
    if (value !== undefined) prefill[key] = value;
  }

  for (const field of fields) {
    // A custom field whose key collides with a builtin or a reserved param
    // can't be addressed from the URL — the builtin wins. Keys are
    // lowercase-with-underscores by schema rule, so this is defensive only.
    // Exception: `contributionAmount` — when a field def carries that key,
    // the admin took the question over as a configurable field (issue #179),
    // the hardcoded input doesn't render, and the param belongs to the
    // extras. The two can never coexist (page.tsx gates on the field row).
    if (RESERVED_PARAMS.has(field.key)) continue;
    if (
      (BUILTIN_KEYS as readonly string[]).includes(field.key) &&
      field.key !== "contributionAmount"
    ) {
      continue;
    }

    const raw = readParam(params, field.key);
    if (raw === undefined) continue;

    const value = coerceExtra(raw, field);
    if (value !== undefined) prefill.extras[field.key] = value;
  }

  return prefill;
}

function coerceExtra(
  raw: string,
  field: PrefillFieldDef,
): PrefillValue | undefined {
  switch (field.type) {
    case "CHECKBOX":
      return coerceBoolean(raw);

    case "SELECT": {
      // Only a real option value — a stray string would render as a select
      // with no matching <option> and silently submit as empty.
      const trimmed = raw.trim();
      return field.options.some((o) => o.value === trimmed)
        ? trimmed
        : undefined;
    }

    case "MULTISELECT": {
      const wanted = raw
        .split(",")
        .map((v) => v.trim())
        .filter(Boolean);
      const valid = wanted.filter((v) =>
        field.options.some((o) => o.value === v),
      );
      // Dedupe: the checkbox group keys on value, and a repeated value would
      // make "uncheck" leave a copy behind.
      const unique = [...new Set(valid)].slice(0, MAX_MULTISELECT_VALUES);
      return unique.length > 0 ? unique : undefined;
    }

    case "NUMBER": {
      const trimmed = raw.trim();
      if (trimmed === "" || !Number.isFinite(Number(trimmed))) return undefined;
      return trimmed;
    }

    case "DATE": {
      // The date input only accepts yyyy-mm-dd; anything else renders blank.
      const trimmed = raw.trim();
      return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : undefined;
    }

    default:
      return truncate(raw.trim());
  }
}

// "1" / "true" / "yes" / "on" (case-insensitive) check the box; "0" / "false" /
// "no" / "off" explicitly clear it. Anything else is treated as unspecified so
// a typo can't silently opt someone in.
function coerceBoolean(raw: string): boolean | undefined {
  const v = raw.trim().toLowerCase();
  if (v === "1" || v === "true" || v === "yes" || v === "on") return true;
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return undefined;
}

// Same shape the signup schema demands (whole euros, up to 2 decimals) — a
// value it would reject is dropped rather than prefilled into a field that
// then fails validation the moment the visitor hits submit.
function coerceAmount(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;
  return /^\d+(\.\d{1,2})?$/.test(trimmed) ? trimmed : undefined;
}

function truncate(value: string): string {
  return value.length > MAX_TEXT_LENGTH
    ? value.slice(0, MAX_TEXT_LENGTH)
    : value;
}
