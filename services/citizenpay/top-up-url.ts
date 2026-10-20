// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AllocationMode } from "@/services/db/generated/enums";
import { getFundUrl } from "@/services/fund/host";

// The CitizenPay treasury's `topUpUrl` — what the public card wallet
// (tap.citizenpay.eu/card/<serial>?network=<slug>) opens from its "Add funds"
// button. The literal `{serial}` placeholder is expanded by the wallet with the
// card's serial, landing the member on the fund's contribution page
// (app/(fund-public)/pay/[serial]).
//
// Only PAY_AND_GO funds mint per deposit, so only they get the button:
// FIXED_PERIOD and DISABLED funds return null (CP then hides it).
//
// Pure: host arithmetic via services/fund/host.ts (same scheme/port logic as
// every other cross-host fund link — https in production, http + PORT in dev,
// `acme.lacaisse.eu` rewritten to `acme.localhost` off the prod apex).
export const TOP_UP_SERIAL_PLACEHOLDER = "{serial}";

export function topUpUrlFor(fund: {
  domain: string;
  allocationMode: AllocationMode;
}): string | null {
  if (fund.allocationMode !== "PAY_AND_GO") return null;
  return `${getFundUrl(fund.domain)}/pay/${TOP_UP_SERIAL_PLACEHOLDER}`;
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
