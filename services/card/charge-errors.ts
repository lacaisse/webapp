// SPDX-License-Identifier: AGPL-3.0-or-later
// What the dialog shows for a refused card charge, from the api's status and
// sentence. Pure; shared by the server action and its tests.

/** The api's refusals the reader can act on, by their sentence. */
const CHARGE_ERRORS: Readonly<Record<string, string>> = {
  "invalid card pin": "cards.admin.charge.errors.pinInvalid",
  "card pin temporarily locked": "cards.admin.charge.errors.pinLocked",
  "card is blocked": "cards.admin.charge.errors.cardBlocked",
  "card not found": "cards.admin.charge.errors.cardNotFound",
  "insufficient card balance": "cards.admin.charge.errors.insufficient",
  "order already paid": "cards.admin.charge.errors.alreadyPaid",
  "order is being charged or confirmed":
    "cards.admin.charge.errors.beingCharged",
  "order not found": "cards.admin.charge.errors.orderNotFound",
  "badge blocked": "cards.admin.charge.errors.badgeBlocked",
  "badge lost": "cards.admin.charge.errors.badgeLost",
  "badge not assigned": "cards.admin.charge.errors.badgeNotAssigned",
  "place has no account_address": "cards.admin.charge.errors.noDestination",
  "place account unavailable": "cards.admin.charge.errors.noDestination",
  "place not found": "cards.admin.charge.errors.placeNotFound",
};

/**
 * The i18n key for a refused charge, or null when the api's own sentence is
 * the thing to show (a 409 naming the order's status, a 500 with the
 * bundler's cause, a 422 the treasury must fix). Nothing is inferred from the
 * status alone: every refusal of the charge routes carries a sentence, and
 * one we do not know is shown as sent rather than guessed at.
 */
export function chargeErrorKey(message: string): string | null {
  return CHARGE_ERRORS[message.trim().toLowerCase()] ?? null;
}

/**
 * An amount typed in the token's units ("12.50", "12,50", "12") as integer
 * cents, or null when it is not a positive amount with at most two decimals.
 * Thousands separators are not accepted: "1.000" is one unit, not a thousand,
 * and the reader should see that before charging.
 */
export function parseAmountCents(input: string): number | null {
  const m = /^\s*(\d+)(?:[.,](\d{1,2}))?\s*$/.exec(input);
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(cents) || cents <= 0) return null;
  return cents;
}

/** The api's shape for the manual route's idempotency key. */
export const CHARGE_IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const CHARGE_PIN_HASH_RE = /^[0-9a-f]{64}$/;
export const CHARGE_DESCRIPTION_MAX = 200;

/** One key per opened dialog, the same on every retry of its attempt. */
export function newChargeIdempotencyKey(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `k${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}
