// SPDX-License-Identifier: AGPL-3.0-or-later

// Canonical form for a card NFC serial: trimmed + uppercased. Serials are hex
// UUIDs (case-insensitive by nature), so storing one canonical form stops the
// global @unique(serialNumber) from admitting case/whitespace variants of the
// same physical card — the cause of duplicate-looking rows after re-imports.
// It also matches what the bank-transfer matcher compares against
// (parseCardSerial uppercases). Apply at every serial write/lookup boundary.
export function normalizeSerial(serial: string): string {
  return serial.trim().toUpperCase();
}
