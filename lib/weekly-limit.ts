// SPDX-License-Identifier: AGPL-3.0-or-later
// Card weekly source limit: the euro text input on the card detail page and
// the cents value CitizenPay stores (`source_weekly_limit`). Pure, shared by
// the client input and the server action.

/** Highest weekly source limit La Caisse lets a fund set: €10,000. */
export const MAX_WEEKLY_LIMIT_CENTS = 1_000_000;

export type EuroInputError = "invalid" | "negative" | "tooLarge";

export type EuroInputResult =
  | { ok: true; cents: number | null }
  | { ok: false; error: EuroInputError };

/**
 * Parse what an operator typed into the weekly limit field into cents.
 * Accepts "10", "10,5", "10.50", ".5", "€ 10" or "10 €"; blank → null (no
 * limit). Rejects a lone "€", thousands separators (also "1 000"), more than
 * two decimals, negatives and anything above MAX_WEEKLY_LIMIT_CENTS. "0" parses to 0 (which CP reads as
 * "no limit" too).
 */
export function parseEuroInput(raw: string): EuroInputResult {
  // Only a truly blank field clears the cap; a stray "€" must not.
  if (raw.trim() === "") return { ok: true, cents: null };
  const s = raw.trim().replace(/^€\s*|\s*€$/g, "");
  const m = /^(-?)(\d*)(?:[.,](\d{0,2}))?$/.exec(s);
  if (!m || (m[2] === "" && !m[3])) return { ok: false, error: "invalid" };
  const [, sign, whole, frac = ""] = m;
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  if (sign && cents > 0) return { ok: false, error: "negative" };
  if (cents > MAX_WEEKLY_LIMIT_CENTS) return { ok: false, error: "tooLarge" };
  return { ok: true, cents };
}

/**
 * Cents → the text shown in the input: "10" for whole euros, "10,50"
 * otherwise (with the locale's decimal separator). Null / 0 → "" (no limit).
 */
export function formatEuroInput(
  cents: number | null,
  decimalSeparator: "," | "." = ",",
): string {
  if (!cents) return "";
  const whole = Math.floor(cents / 100);
  const frac = cents % 100;
  return frac === 0
    ? String(whole)
    : `${whole}${decimalSeparator}${String(frac).padStart(2, "0")}`;
}

/** Server-side guard: null, or an integer number of cents in range. */
export function isValidWeeklyLimitCents(v: unknown): v is number | null {
  return (
    v === null ||
    (typeof v === "number" &&
      Number.isInteger(v) &&
      v >= 0 &&
      v <= MAX_WEEKLY_LIMIT_CENTS)
  );
}
