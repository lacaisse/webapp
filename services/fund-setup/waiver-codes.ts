// SPDX-License-Identifier: AGPL-3.0-or-later
import { randomInt } from "node:crypto";

// Subscription waiver codes — the shape of the code itself. Minting and
// redeeming live in waiver-admin-actions.ts / admin-actions.ts; this module
// is pure so both sides, and the tests, agree on what a code looks like.
//
// A code is 12 symbols of Crockford base32 (digits + uppercase letters minus
// I, L, O, U, which read like 1, 1, 0, V), ~60 bits from a CSPRNG. It is
// stored normalised (uppercase, no separators) and shown in groups of four,
// "7K3P-M2QX-9RTD", because that is how people copy a code from a message.

export const WAIVER_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const WAIVER_CODE_LENGTH = 12;

export function generateWaiverCode(): string {
  let out = "";
  for (let i = 0; i < WAIVER_CODE_LENGTH; i++) {
    out += WAIVER_CODE_ALPHABET[randomInt(WAIVER_CODE_ALPHABET.length)];
  }
  return out;
}

// What a person typed → what is stored: case, spaces and dashes don't matter,
// and the letters the alphabet left out map to the digit they resemble, so
// "7k3p-m2qx-9rtd" and "7K3P M2QX 9RTD" and a misread O for 0 all match.
export function normaliseWaiverCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
}

export function isWellFormedWaiverCode(normalised: string): boolean {
  if (normalised.length !== WAIVER_CODE_LENGTH) return false;
  for (const ch of normalised) {
    if (!WAIVER_CODE_ALPHABET.includes(ch)) return false;
  }
  return true;
}

export function formatWaiverCode(normalised: string): string {
  return normalised.match(/.{1,4}/g)?.join("-") ?? normalised;
}

// Why a code can't be redeemed right now, in the order a person would want to
// hear it: revoked beats expired beats used up.
export type WaiverCodeState = "active" | "revoked" | "expired" | "exhausted";

export function waiverCodeState(
  code: {
    revokedAt: Date | null;
    expiresAt: Date | null;
    maxUses: number;
    usedCount: number;
  },
  now: Date = new Date(),
): WaiverCodeState {
  if (code.revokedAt) return "revoked";
  if (code.expiresAt && code.expiresAt.getTime() <= now.getTime()) return "expired";
  if (code.usedCount >= code.maxUses) return "exhausted";
  return "active";
}
