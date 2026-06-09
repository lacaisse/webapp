// SPDX-License-Identifier: AGPL-3.0-or-later

// Pure parsers for the reference / communication field of an incoming bank
// transfer. No DB access — these turn the messy free-text reference into a
// candidate card serial or card number, which the matcher then resolves
// against the database. Tested in parse.test.mjs against real samples.

// --- Card serial -----------------------------------------------------------
//
// Card serials are the NFC UUID printed on the card: 12–16 hex chars that
// always contain at least one A–F letter (e.g. "04516F320A1291",
// "044981AA1D1290"). Members wrap them inconsistently: "class-…", "Class - …",
// "class …", "CLASS…", or no prefix at all, in any case. We strip the "CLASS"
// marker and punctuation, then look for a hex token of the right shape.
//
// The "must contain a letter" rule is load-bearing: it stops a 12-digit
// structured communication (pure digits) from being mistaken for a serial.

export function parseCardSerial(
  ...refs: (string | null | undefined)[]
): string | null {
  for (const raw of refs) {
    if (!raw) continue;
    const cleaned = raw
      .toUpperCase()
      .replace(/CLASS/g, " ") // drop the marker word wherever it sits
      .replace(/[^0-9A-Z]+/g, " "); // normalise separators to spaces
    for (const token of cleaned.split(/\s+/)) {
      if (token.length < 12 || token.length > 16) continue;
      if (!/^[0-9A-F]+$/.test(token)) continue; // hex chars only
      if (!/[A-F]/.test(token)) continue; // has a letter → not an OGM
      return token;
    }
  }
  return null;
}

// --- Belgian structured communication (OGM/VCS) ----------------------------
//
// 12 digits formatted "+++XXX/XXXX/XXXXX+++" or "000/0000/01717". The first
// 10 digits are the base = the card's per-fund number (1…N); the last 2 are
// the check = base mod 97 (97 when the remainder is 0). We're strict: exactly
// 12 digits and a valid checksum. Looser numbers ("000038", "000179") fail
// here on purpose and fall through to manual attribution.

export function parseStructuredCommunication(
  ...refs: (string | null | undefined)[]
): number | null {
  for (const raw of refs) {
    if (!raw) continue;
    const digits = raw.replace(/\D/g, "");
    if (digits.length !== 12) continue;
    const base = Number(digits.slice(0, 10));
    const check = Number(digits.slice(10));
    if (base <= 0) continue;
    const mod = base % 97 || 97;
    if (mod !== check) continue;
    return base; // = Card.number
  }
  return null;
}
