// SPDX-License-Identifier: AGPL-3.0-or-later

// Shared (client + server) config for member CSV import. Kept out of the
// "use server" action file so the client mapping UI can import the field list
// and types ("use server" modules may only export async functions).

// The built-in member fields a CSV column can be mapped to. `serial` is special
// — it links an existing unattached card rather than writing a Member column.
export const MEMBER_IMPORT_FIELDS = [
  { key: "firstName", required: true },
  { key: "lastName", required: true },
  { key: "email", required: true },
  { key: "phone", required: false },
  { key: "iban", required: false },
  { key: "address", required: false },
  { key: "postalCode", required: false },
  { key: "city", required: false },
  { key: "householdAdults", required: false },
  { key: "householdChildren", required: false },
  { key: "tier", required: false },
  { key: "notes", required: false },
  { key: "serial", required: false },
] as const;

export type MemberImportField = (typeof MEMBER_IMPORT_FIELDS)[number]["key"];

// field → CSV header name. Only mapped fields are present.
export type MemberImportMapping = Partial<Record<MemberImportField, string>>;

export type MemberImportResult =
  | { error: string }
  | {
      ok: true;
      created: number;
      updated: number;
      skipped: { row: number; reason: string }[];
      cardsLinked: number;
      serialsNotFound: string[];
    };
