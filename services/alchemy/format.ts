// SPDX-License-Identifier: AGPL-3.0-or-later

// On-chain amounts arrive as integer strings (e.g. `"12345600"` for a
// token with 6 decimals = `12.3456`). We keep formatting here so it's
// shared between the transfers and holders tables and doesn't depend on
// floating-point math (token amounts can exceed Number.MAX_SAFE_INTEGER).

const ZERO = "0";

function stripHexPrefix(s: string): string {
  return s.startsWith("0x") || s.startsWith("0X") ? s.slice(2) : s;
}

function hexToDecimalString(hex: string): string {
  const clean = stripHexPrefix(hex).replace(/^0+/, "");
  if (!clean) return ZERO;
  let result = "0";
  for (const ch of clean) {
    const digit = parseInt(ch, 16);
    // result = result * 16 + digit, as a decimal string
    let carry = digit;
    let next = "";
    for (let i = result.length - 1; i >= 0; i--) {
      const v = parseInt(result[i]!, 10) * 16 + carry;
      next = (v % 10).toString() + next;
      carry = Math.floor(v / 10);
    }
    while (carry > 0) {
      next = (carry % 10).toString() + next;
      carry = Math.floor(carry / 10);
    }
    result = next;
  }
  return result;
}

/**
 * Convert a hex or decimal integer string into a human-readable token
 * amount given the token's decimals. Examples (decimals=6):
 *   "0xbc614e"  -> "12.345678"
 *   "12345600"  -> "12.3456"
 *   "0"         -> "0"
 *
 * Truncates trailing zeros after the decimal point. Falls back to "0"
 * for empty / unparseable input rather than throwing — the explorer
 * should degrade rather than blow up on a malformed row.
 */
export function formatTokenAmount(
  raw: string | null | undefined,
  decimals: number | null,
): string {
  if (!raw) return ZERO;
  const dec = decimals ?? 0;

  let intStr: string;
  if (raw.startsWith("0x") || raw.startsWith("0X")) {
    intStr = hexToDecimalString(raw);
  } else {
    intStr = raw.replace(/^0+/, "") || ZERO;
  }

  if (dec === 0) return intStr;

  if (intStr.length <= dec) {
    intStr = intStr.padStart(dec + 1, "0");
  }
  const whole = intStr.slice(0, intStr.length - dec);
  const frac = intStr.slice(intStr.length - dec).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** "0xabcd...1234" — trimmed address for display when no name resolves. */
export function shortAddress(address: string): string {
  const a = address.toLowerCase();
  if (a.length <= 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

export function isZeroAddress(address: string): boolean {
  return address.toLowerCase() === ZERO_ADDRESS;
}
