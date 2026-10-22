// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AllocationMode } from "@/services/db/generated/enums";
import { getFundUrl } from "@/services/fund/host";

// The CitizenPay treasury's `topUpUrl` — what the public card wallet
// (tap.citizenpay.eu/card/<serial>?network=<slug>) opens from its "Add funds"
// button. The literal `{serial}` placeholder is expanded by the wallet with the
// card's serial.
//
//   - FIXED_PERIOD: La Caisse publishes the fund's cotisation page
//     (app/(fund-public)/pay/[serial] — IBAN + EPC QR for the monthly
//     contribution), which is what the previous wallet linked for them.
//   - PAY_AND_GO: null. Citizen Pay serves the checkout link itself: its api's
//     `GET /v2/treasuries` falls back to a default `top_up_url`
//     (`https://checkout.citizenpay.xyz/top-up/<treasury slug>?serial={serial}`)
//     for a treasury whose row has none, once the issuer has a top-up place
//     (`topup_place`). So La Caisse stops publishing its own `/pay/{serial}`
//     link for these funds and clears the one it published before, letting
//     CP's checkout take over. (The `/pay/[serial]` open-banking page still
//     works; the wallet just no longer links to it.)
//   - DISABLED: null — the fund takes no money from members.
//
// The sync turns a null into "clear our own link if it's there", never "clear
// whatever is there" (see isOwnTopUpUrl).
//
// Pure: host arithmetic via services/fund/host.ts (same scheme/port logic as
// every other cross-host fund link — https in production, http + PORT in dev,
// `acme.lacaisse.eu` rewritten to `acme.localhost` off the prod apex).
export const TOP_UP_SERIAL_PLACEHOLDER = "{serial}";

export function topUpUrlFor(fund: {
  domain: string;
  allocationMode: AllocationMode;
}): string | null {
  // PAY_AND_GO → CP's checkout (CP's default top_up_url), DISABLED → nothing.
  if (fund.allocationMode !== "FIXED_PERIOD") return null;
  return ownTopUpUrl(fund.domain);
}

function ownTopUpUrl(domain: string): string {
  return `${getFundUrl(domain)}/pay/${TOP_UP_SERIAL_PLACEHOLDER}`;
}

/**
 * Whether `url` is a top-up link La Caisse published for this fund — its own
 * `/pay/{serial}` page, as this environment builds it or in its production
 * https form. Only such a link may be cleared when a fund computes no link
 * (PAY_AND_GO, DISABLED): a treasury can carry a value CitizenPay manages
 * itself (CP's own checkout — Brussels Pay's, or the one CP now publishes for
 * PAY_AND_GO funds), and La Caisse has no business removing it.
 */
export function isOwnTopUpUrl(
  fund: { domain: string },
  url: string | null,
): boolean {
  if (url === null) return false;
  return (
    url === ownTopUpUrl(fund.domain) ||
    url === `https://${fund.domain}/pay/${TOP_UP_SERIAL_PLACEHOLDER}`
  );
}

/**
 * Whether a top-up URL may be sent to a real CitizenPay treasury: null (clear)
 * always may; a link only when it's https. A dev host
 * (`http://acme.localhost:3000/…`) or a prod domain built without
 * NODE_ENV=production (`http://acme.lacaisse.eu:3000/…`) may not.
 */
export function isPublishableTopUpUrl(url: string | null): boolean {
  return url === null || url.startsWith("https://");
}
