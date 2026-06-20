// SPDX-License-Identifier: AGPL-3.0-or-later

// Shared helpers for the admin table search boxes (members, cards). Pure —
// safe to import from server components and where-clause builders alike.

// Split a free-text query into whitespace-separated tokens. Used for
// multi-word name matching ("John Doe" → ["John", "Doe"]) where each token
// should independently match a first/last name.
export function searchTokens(q: string): string[] {
  return q.split(/\s+/).filter(Boolean);
}

// A query that is purely a (optionally `#`-prefixed) integer is treated as a
// card-number lookup in addition to the usual substring match. Returns null
// for anything that isn't a clean positive integer so alphanumeric serials
// fall through to a `contains` match instead.
export function parseCardNumber(q: string): number | null {
  const m = q.match(/^#?(\d+)$/);
  if (!m) return null;
  const n = Number.parseInt(m[1], 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}
