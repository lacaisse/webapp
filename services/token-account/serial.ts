// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";

// The serial we assign to a SOURCE account so CitizenPay can reference it as a
// card's pull-from source (CP keys sources by serial string).
//
// Hard constraint: it must NEVER collide with an NFC UUID — CitizenPay's card
// serials are 14 uppercase hex chars (/^[0-9A-F]{14}$/, see
// scripts/seed-demo.ts::generateCardSerial). The literal "ACCT-" prefix and the
// "-" separators put this value permanently outside that namespace regardless
// of the fund code / salt.
//
// Deterministic from (fundId, saltNonce): the fund code is a stable slice of
// sha256(fundId) — globally distinct per fund without leaking the id — and the
// suffix is the account's per-fund salt (already unique via the
// (fundId, saltNonce) constraint). So the serial is reproducible and unique per
// fund. The DB's unique index on `serial` is the backstop for the (vanishingly
// unlikely) cross-fund code collision.
export function fundAccountSerial(fundId: string, saltNonce: number): string {
  const code = createHash("sha256")
    .update(fundId)
    .digest("hex")
    .slice(0, 8)
    .toUpperCase();
  return `ACCT-${code}-${saltNonce}`;
}
