// SPDX-License-Identifier: AGPL-3.0-or-later
import { getFundUrl } from "@/services/fund/server";

// Absolute URL of a member's public "pay your cotisation" page. Built off the
// fund's canonical host so it's safe to drop into an email (cross-host — a
// relative path wouldn't carry the fund identity). `serial` is the member's
// card UID (`Card.serialNumber`), which the page uses to look the card — and
// thus the member — up, and which doubles as the bank-transfer reference.
//
// `domain` is the value stored on `Fund.domain` (see getFundUrl).
export function buildPaymentPageUrl(domain: string, serial: string): string {
  return `${getFundUrl(domain)}/pay/${encodeURIComponent(serial)}`;
}
