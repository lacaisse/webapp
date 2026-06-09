// SPDX-License-Identifier: AGPL-3.0-or-later

// Name normalisation + scoring, used ONLY to rank member suggestions in the
// manual attribution picker against a deposit's counterpart name. Heuristic,
// never an auto-match. Handles the messy real-world shapes: titles (M, MME,
// MLE…), reversed order (lastName firstName), couples ("Ramaekers - EVENS"),
// accents, and case.

const TITLES = new Set([
  "M", "MR", "MRS", "MS", "MME", "MLE", "MLLE", "MM", "DR", "ME",
  "MADAME", "MONSIEUR", "MADEMOISELLE",
]);
const CONNECTORS = new Set(["ET", "OU", "EN", "AND", "OR"]);

// Significant uppercase, accent-stripped name tokens (titles/connectors and
// 1-char fragments dropped).
export function nameTokens(s: string | null | undefined): string[] {
  if (!s) return [];
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip diacritics
    .toUpperCase()
    .split(/[^A-Z]+/) // letters only — drops digits, punctuation, slashes
    .filter(
      (tok) => tok.length >= 2 && !TITLES.has(tok) && !CONNECTORS.has(tok),
    );
}

// 0..1 — fraction of the member's name tokens present in the counterpart name.
// Order-independent (so "Rakofsky Nadine" matches member Nadine Rakofsky).
export function scoreNameMatch(
  counterpartName: string | null | undefined,
  firstName: string,
  lastName: string,
): number {
  const counter = new Set(nameTokens(counterpartName));
  if (counter.size === 0) return 0;
  const memberToks = nameTokens(`${firstName} ${lastName}`);
  if (memberToks.length === 0) return 0;
  let hit = 0;
  for (const tok of memberToks) if (counter.has(tok)) hit++;
  return hit / memberToks.length;
}
