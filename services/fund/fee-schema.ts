// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";

// Settings → Fees: the fixed fee per order. Shared by the form (initial value)
// and the server action (validation + conversion). Not a "use server" module,
// so constants and sync helpers may live here.
//
// The admin types euros ("0.10", "0,10", "1"); the column and the wire hold
// integer cents. The cap matches the api's (`fixedFeeCents` 0–1000).

export const FIXED_FEE_MAX_CENTS = 1000;

// Up to two decimals, dot or comma (the French / Dutch keyboard habit).
const EURO_PATTERN = /^\d{1,4}([.,]\d{1,2})?$/;

/**
 * "0.10" → 10, "1,5" → 150, "10" → 1000. Pure string arithmetic — no float
 * multiply, so "0.29" is 29, never 28.999…. Expects an input that passed
 * `payoutFixedFeeField`; anything else throws.
 */
export function euroToCents(value: string): number {
  const v = value.trim();
  if (!EURO_PATTERN.test(v)) throw new Error(`not a euro amount: ${value}`);
  const [whole, frac = ""] = v.replace(",", ".").split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

/** 10 → "0.10"; 0 → "" (the form shows an empty field for "no fixed fee"). */
export function centsToEuroInput(cents: number): string {
  if (!Number.isInteger(cents) || cents <= 0) return "";
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

// The form field. "" / null = no fixed fee (stored as 0); undefined = the
// caller did not send it (an older client) and the stored value is kept.
// Whitespace-only counts as empty. Zod runs every refinement even after one
// failed, so the second re-checks the pattern before converting.
export const payoutFixedFeeField = z
  .string()
  .trim()
  .refine((v) => v === "" || EURO_PATTERN.test(v), {
    error: "settings.errors.fixedFeeInvalid",
  })
  .refine(
    (v) => v === "" || !EURO_PATTERN.test(v) || euroToCents(v) <= FIXED_FEE_MAX_CENTS,
    { error: "settings.errors.fixedFeeTooHigh" },
  )
  .nullable()
  .optional();

/**
 * The form's value after a successful save: "0,1" → "0.10", "  " → "".
 * Anything unparseable is returned as typed.
 */
export function normaliseFixedFeeInput(value: string): string {
  const v = value.trim();
  if (v === "") return "";
  return EURO_PATTERN.test(v) ? centsToEuroInput(euroToCents(v)) : value;
}
