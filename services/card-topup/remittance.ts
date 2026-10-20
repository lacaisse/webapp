// SPDX-License-Identifier: AGPL-3.0-or-later

// CitizenPay's remittance for a treasury payment request without an order is
// "cp-<paymentRequestId>" (an order's is "cp-order-<orderId>", which is NOT a
// top-up). Pure parser, tested in remittance.test.ts.
//
// Strict on purpose: the hyphen form only, as its own token. A miss falls back
// to the regular matching, and the top-up still gets minted through CP's
// status (the sweeper) — but a false hit would steer a real cotisation away
// from its tier mint.
const TOP_UP_REMITTANCE = /(?:^|[^a-z0-9-])cp-(\d{1,12})(?![\d-])/i;

export function parseTopUpRemittance(
  ...refs: (string | null | undefined)[]
): number | null {
  for (const raw of refs) {
    if (!raw) continue;
    const m = TOP_UP_REMITTANCE.exec(raw);
    if (!m) continue;
    const id = Number(m[1]);
    if (Number.isSafeInteger(id) && id > 0) return id;
  }
  return null;
}
