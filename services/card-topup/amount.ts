// SPDX-License-Identifier: AGPL-3.0-or-later
import { z } from "zod";

// Pure amount rules for the open-banking card top-up (/pay/<serial>). Shared
// by the client form and the server action, so no server-only imports here.

/** Preset buttons, in cents. */
export const TOP_UP_PRESETS_CENTS = [500, 1000, 2500, 5000] as const;
export const TOP_UP_MIN_CENTS = 100; // €1
export const TOP_UP_MAX_CENTS = 50_000; // €500

export type TopUpAmountError =
  | "cotisation.topUp.errors.amountInvalid"
  | "cotisation.topUp.errors.amountMin"
  | "cotisation.topUp.errors.amountMax";

/**
 * Parse a typed euro amount ("12", "12.5", "12,50", "€ 12,50") into integer
 * cents. At most two decimals; a comma is accepted as the decimal separator
 * (fr / nl keyboards). Thousands separators are not — "1.000" reads as €1.
 * Errors are i18n keys.
 */
export function parseTopUpAmount(
  input: string,
): { ok: true; cents: number } | { ok: false; error: TopUpAmountError } {
  const cleaned = input.replace(/[€\s]/g, "").replace(",", ".");
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(cleaned)) {
    return { ok: false, error: "cotisation.topUp.errors.amountInvalid" };
  }
  const [whole, frac = ""] = cleaned.split(".");
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, "0"));
  return validateTopUpCents(cents);
}

/** Range-check an amount already in cents. */
export function validateTopUpCents(
  cents: number,
): { ok: true; cents: number } | { ok: false; error: TopUpAmountError } {
  if (!Number.isSafeInteger(cents) || cents <= 0) {
    return { ok: false, error: "cotisation.topUp.errors.amountInvalid" };
  }
  if (cents < TOP_UP_MIN_CENTS) {
    return { ok: false, error: "cotisation.topUp.errors.amountMin" };
  }
  if (cents > TOP_UP_MAX_CENTS) {
    return { ok: false, error: "cotisation.topUp.errors.amountMax" };
  }
  return { ok: true, cents };
}

/** Cents → the 2-decimal euro string the TokenOperation row stores ("12.50"). */
export function centsToEuroString(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/**
 * Cents → token base units, 1 euro = 1 token: cents × 10^(decimals − 2). For a
 * token with fewer than 2 decimals the amount must divide evenly, else throws
 * (the caller refuses rather than rounding someone's money).
 */
export function centsToTokenUnits(cents: number, decimals: number): bigint {
  if (!Number.isSafeInteger(cents) || cents < 0) {
    throw new Error(`invalid cents amount: ${cents}`);
  }
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`invalid token decimals: ${decimals}`);
  }
  const ten = BigInt(10);
  if (decimals >= 2) return BigInt(cents) * ten ** BigInt(decimals - 2);
  const divisor = ten ** BigInt(2 - decimals);
  if (BigInt(cents) % divisor !== BigInt(0)) {
    throw new Error(
      `${cents} cents is not representable with ${decimals} token decimals`,
    );
  }
  return BigInt(cents) / divisor;
}

// Server action input. `amountCents` comes from the form (presets or the
// parsed custom field) and is re-validated here; error messages are i18n keys.
export const StartCardTopUpSchema = z.object({
  serial: z.string().trim().min(1).max(64),
  amountCents: z
    .number()
    .int({ error: "cotisation.topUp.errors.amountInvalid" })
    .min(TOP_UP_MIN_CENTS, { error: "cotisation.topUp.errors.amountMin" })
    .max(TOP_UP_MAX_CENTS, { error: "cotisation.topUp.errors.amountMax" }),
  bankId: z
    .string({ error: "cotisation.topUp.errors.bankRequired" })
    .trim()
    .min(1, { error: "cotisation.topUp.errors.bankRequired" })
    .max(128),
  // Only for banks that need the payer's IBAN up front. Normalised (spaces
  // dropped, upper-cased) and loosely shape-checked; the bank validates it.
  iban: z
    .string()
    .trim()
    .transform((v) => v.replace(/\s+/g, "").toUpperCase())
    .refine((v) => v === "" || /^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/.test(v), {
      error: "cotisation.topUp.errors.ibanInvalid",
    })
    .optional(),
});

export type StartCardTopUpInput = z.input<typeof StartCardTopUpSchema>;
