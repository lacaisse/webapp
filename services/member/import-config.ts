// SPDX-License-Identifier: AGPL-3.0-or-later

// Shared (client + server) config for member CSV import. Kept out of the
// "use server" action file so the client mapping UI can import the field list
// and types ("use server" modules may only export async functions).

import type { MemberStatus } from "@/services/db/generated/enums";
import {
  isSupportedLocale,
  type SupportedLocale,
} from "@/services/i18n/config";

// The built-in member fields a CSV column can be mapped to. `serial` and
// `cardNumber` are special — they link an EXISTING card (by serial / by the
// per-fund 1…N number) rather than writing a Member column. Member import
// never creates cards: cards are synced from CitizenPay or registered via the
// card flows; unknown values are reported, not provisioned (provisioning from
// here once minted junk CP cards).
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
  { key: "locale", required: false },
  { key: "status", required: false },
  { key: "notes", required: false },
  // serial before cardNumber: the auto-guess assigns headers in field order,
  // so "card serial" must be claimed by serial before "card…" falls to number.
  { key: "serial", required: false },
  { key: "cardNumber", required: false },
] as const;

export type MemberImportField = (typeof MEMBER_IMPORT_FIELDS)[number]["key"];

// field → CSV header name. Only mapped fields are present.
export type MemberImportMapping = Partial<Record<MemberImportField, string>>;

// The status applied to a member when import doesn't resolve one.
export const DEFAULT_IMPORT_STATUS: MemberStatus = "NEW";

// Raw CSV status value (lower-cased) → our MemberStatus. Built by the dialog's
// interactive mapping step and re-validated server-side. See recognizeStatus
// for the auto-recognition of common synonyms.
export type StatusValueMap = Record<string, MemberStatus>;

// Recognize a raw status value from external data, case-insensitively, across
// EN/FR/NL synonyms. Returns null when nothing matches — the dialog then asks
// the admin to map it explicitly (and the server falls back to the default).
export function recognizeStatus(raw: string): MemberStatus | null {
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  // Exact enum value (any case) always wins.
  const exact = (
    ["NEW", "ACTIVE", "INACTIVE", "PAUSED", "STOPPED", "REJECTED"] as const
  ).find((s) => s.toLowerCase() === v);
  if (exact) return exact;
  if (/^(new|nouveau|nouvelle|nieuw|inscrit|signed.?up|pending|en.?attente)$/.test(v))
    return "NEW";
  if (/^(active|actif|actieve?|enabled)$/.test(v)) return "ACTIVE";
  if (/^(inactive|inactif|inactieve?|disabled|on.?file)$/.test(v))
    return "INACTIVE";
  if (/^(paused|pause|en.?pause|gepauzeerd|on.?hold|hold)$/.test(v))
    return "PAUSED";
  if (/^(stopped|stop|arr[êe]t[ée]?|parti|resigned|left|gestopt|cancelled|canceled|annul[ée])$/.test(v))
    return "STOPPED";
  if (/^(rejected|rejet[ée]?|refus[ée]|geweigerd|denied|declined)$/.test(v))
    return "REJECTED";
  return null;
}

// Recognize a raw language value from external data, case-insensitively, across
// ISO codes and EN/FR/NL/ES names. Returns null when nothing matches — the row
// is then left without an explicit locale (emails fall back to the fund
// default), same as an unmatched tier name. Mirrors recognizeStatus.
export function recognizeLocale(raw: string): SupportedLocale | null {
  const v = raw.trim().toLowerCase();
  if (!v) return null;
  // Exact supported code (e.g. "fr", "en") always wins.
  if (isSupportedLocale(v)) return v;
  if (/^(fr|fre|fra|french|fran[çc]ais|frans|franc[eé]s)$/.test(v)) return "fr";
  if (/^(en|eng|english|anglais|engels|ingl[eé]s)$/.test(v)) return "en";
  if (
    /^(nl|dut|nld|dutch|n[ée]erlandais|nederlands|flemish|flamand|vlaams)$/.test(
      v,
    )
  )
    return "nl";
  if (/^(es|spa|spanish|espagnol|spaans|espa[ñn]ol)$/.test(v)) return "es";
  return null;
}

export type MemberImportResult =
  | { error: string }
  | {
      ok: true;
      created: number;
      updated: number;
      skipped: { row: number; reason: string }[];
      cardsLinked: number;
      // Serials / card numbers that didn't link an existing card (no such
      // card, or it belongs to another member). Reported, never created.
      serialsNotFound: string[];
      cardNumbersNotFound: string[];
      // Distinct status values import couldn't recognize and defaulted.
      statusesDefaulted: string[];
    };
