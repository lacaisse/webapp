import { randomBytes } from "node:crypto";

// Per-fund unique reference each member writes on their bank transfer.
// Bank-sync uses it to attribute incoming deposits to the right member.
// Same alphabet as the referral code: 31 chars, no ambiguous 0/O/I/L/1.
// At 8 chars that's ~30^8 ≈ 8.5×10¹¹ values — collision risk negligible,
// but the create action retries on P2002 anyway.

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const LENGTH = 8;

export function generatePaymentReference(): string {
  const bytes = randomBytes(LENGTH);
  let out = "";
  for (let i = 0; i < LENGTH; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}
