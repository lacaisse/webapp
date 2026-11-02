// SPDX-License-Identifier: AGPL-3.0-or-later
import { formatUnits } from "viem";

// Human amounts for quotes, summaries and cards. Raw units stay exact on the
// rows and in the orders; what people read is cut (never rounded up) to a
// few decimals so an 18-decimal token does not print every wei. Pure.

export const DISPLAY_FRACTION_DIGITS = 6;

/** Raw units → "12.3456" (≤ `maxFraction` decimals, trailing zeros dropped). */
export function formatAmount(units: bigint, decimals: number, maxFraction = DISPLAY_FRACTION_DIGITS): string {
  const full = formatUnits(units, decimals);
  const dot = full.indexOf(".");
  if (dot === -1) return full;
  const frac = full.slice(dot + 1, dot + 1 + maxFraction).replace(/0+$/, "");
  const whole = full.slice(0, dot);
  return frac ? `${whole}.${frac}` : whole;
}
