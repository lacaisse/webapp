// SPDX-License-Identifier: AGPL-3.0-or-later

// Case-insensitive token-symbol match after stripping invisible characters
// and spaces ("EURe" vs "eure" vs "EUR\u200Be"). Used to refuse a custom
// display token whose symbol would read like the fund token or a built-in
// (review S8).
export function symbolCollides(symbol: string, taken: (string | null | undefined)[]): boolean {
  const norm = (v: string) => v.replace(/[\p{Cf}\s]/gu, "").toLowerCase();
  const mine = norm(symbol);
  return mine !== "" && taken.some((t) => !!t && norm(t) === mine);
}
