// SPDX-License-Identifier: AGPL-3.0-or-later

// Privacy mode ("demo mode"): a per-browser preference that masks personal
// data (member names, emails, member numbers, IBANs) and per-person money
// (card balances, bank counterparties) across the fund admin area so the
// platform can be shown to outsiders on a live fund. Pure helpers only — the
// cookie is read server-side in services/privacy/server.ts and exposed to
// client components through components/privacy/privacy-provider.tsx.

export const PRIVACY_COOKIE = "privacy";

export type SensitiveKind =
  | "name" // a person's first/last/full name
  | "email"
  | "phone"
  | "number" // member / card numbers, structured references, serials
  | "iban"
  | "amount" // per-person money: card balance, deposit amount
  | "address" // postal address, city, wallet address of a person
  | "text"; // any other free text about a person

// Fixed-width placeholders so masked tables keep their column rhythm. The
// bullet glyph is deliberately generic — it must not look like a real value.
const PLACEHOLDERS: Record<SensitiveKind, string> = {
  name: "•••••• ••••••",
  email: "••••••@••••.••",
  phone: "+•• ••• •• •• ••",
  number: "••••",
  iban: "BE•• •••• •••• ••••",
  amount: "•••,••",
  address: "•••••••••• ••",
  text: "••••••••",
};

export function maskValue(kind: SensitiveKind): string {
  return PLACEHOLDERS[kind];
}

export function isPrivacyCookieOn(value: string | undefined): boolean {
  return value === "1";
}
