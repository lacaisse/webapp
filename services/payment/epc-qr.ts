// SPDX-License-Identifier: AGPL-3.0-or-later

// Builds the payload string for an EPC069-12 ("BCD") SEPA Credit Transfer QR
// code — the "scan to pay" QR every European banking app understands. Feed the
// returned string to `QRCode.toDataURL(...)` to render it.
//
// Field order is fixed by the spec (version 002, UTF-8). We emit up to the
// unstructured remittance line and drop the trailing optional fields:
//
//   1  Service tag           "BCD"
//   2  Version               "002"  (BIC optional in this version)
//   3  Character set         "1"    (UTF-8)
//   4  Identification        "SCT"
//   5  BIC                   (omitted — optional in v002)
//   6  Beneficiary name      max 70 chars
//   7  Beneficiary IBAN      no spaces
//   8  Amount                "EUR"<amount, 2 decimals>  (0.01–999999999.99)
//   9  Purpose               (omitted)
//   10 Remittance (structured)   (omitted — we use unstructured)
//   11 Remittance (unstructured) the payment reference, max 140 chars

export type EpcQrInput = {
  /** Beneficiary (creditor) name, e.g. the fund/ASBL name. */
  beneficiary: string;
  /** Beneficiary IBAN — spaces are stripped, case-normalised to upper. */
  iban: string;
  /** Amount in EUR. Rounded to 2 decimals. Must be > 0. */
  amount: number;
  /** Free-text remittance info — the member's payment reference. */
  reference: string;
};

const NAME_MAX = 70;
const REMITTANCE_MAX = 140;

/**
 * Returns the EPC QR payload, or `null` when the inputs can't produce a valid
 * SEPA transfer QR (missing IBAN or a non-positive amount) — the caller then
 * simply omits the QR rather than rendering a broken one.
 */
export function buildEpcQrPayload(input: EpcQrInput): string | null {
  const iban = input.iban.replace(/\s+/g, "").toUpperCase();
  const amount = Math.round(input.amount * 100) / 100;

  if (!iban || !(amount > 0)) return null;

  const lines = [
    "BCD",
    "002",
    "1",
    "SCT",
    "", // BIC — optional in version 002
    truncate(input.beneficiary.trim(), NAME_MAX),
    iban,
    `EUR${amount.toFixed(2)}`,
    "", // Purpose
    "", // Structured remittance
    truncate(input.reference.trim(), REMITTANCE_MAX),
  ];

  return lines.join("\n");
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}
