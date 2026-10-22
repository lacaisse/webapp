// SPDX-License-Identifier: AGPL-3.0-or-later
// The client digest of a Citizen Pay card PIN, as the pay-pos and the Citizen
// Pay dashboard compute it (pay-pos lib/services/pay/pin_hash.dart):
// keccak256 of `citizenpay:card-pin:<version>:<serial>:<pin>`, lowercase hex,
// no 0x. The raw PIN never leaves the browser — the charge action sends only
// this digest as `pin_hash`, which the api compares against the card's
// registered digest. The serial is the salt, so it must be the exact string
// the charge sends (no case change, no trimming beyond what the form did).
//
// Bumping the version invalidates every registered PIN: it moves in lockstep
// with pay-pos and the Citizen Pay dashboard, never here alone.
//
// No "server-only": the dialog hashes in the browser.

import { keccak256, stringToBytes } from "viem";

export const CARD_PIN_HASH_VERSION = "v1";

export function hashCardPin(serial: string, pin: string): string {
  const message = `citizenpay:card-pin:${CARD_PIN_HASH_VERSION}:${serial}:${pin}`;
  return keccak256(stringToBytes(message)).slice(2);
}
