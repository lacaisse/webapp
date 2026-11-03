// SPDX-License-Identifier: AGPL-3.0-or-later
import { formatExtraAmount } from "@/services/token/extra-tokens";

// Human amounts for quotes, summaries and cards. Raw units stay exact on the
// rows and in the orders; what people read is cut (never rounded up) to two
// decimals, like every other amount in the dashboard — so a minimum shown as
// "0.55" is never more than what is enforced. The cut is the Accounts pages'
// formatExtraAmount, only with a shorter default. Pure.

export const DISPLAY_FRACTION_DIGITS = 2;

/** `part / whole` as a percentage string with two decimals ("0.06"). */
export function percentOf(part: bigint, whole: bigint): string {
  if (whole <= BigInt(0)) return "0";
  const bps100 = (part * BigInt(1_000_000)) / whole; // 1e-4 %
  const whole100 = bps100 / BigInt(10_000);
  const frac = (bps100 % BigInt(10_000)).toString().padStart(4, "0").slice(0, 2).replace(/0+$/, "");
  return frac ? `${whole100}.${frac}` : whole100.toString();
}

/** Raw units → "12.34" (≤ `maxFraction` decimals, trailing zeros dropped). */
export function formatAmount(units: bigint, decimals: number, maxFraction = DISPLAY_FRACTION_DIGITS): string {
  return formatExtraAmount(units.toString(), decimals, maxFraction);
}
