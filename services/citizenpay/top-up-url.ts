// SPDX-License-Identifier: AGPL-3.0-or-later
import type { AllocationMode } from "@/services/db/generated/enums";
import { getFundUrl } from "@/services/fund/host";

// The CitizenPay treasury's `topUpUrl` — what the public card wallet
// (tap.citizenpay.eu/card/<serial>?network=<slug>) opens from its "Add funds"
// button. The literal `{serial}` placeholder is expanded by the wallet with the
// card's serial, landing the member on the fund's contribution page
// (app/(fund-public)/pay/[serial]).
//
// PAY_AND_GO funds get the open-banking top-up there; FIXED_PERIOD funds get
// their cotisation page (IBAN + EPC QR for the monthly contribution), which is
// what the previous wallet linked for them. DISABLED funds take no money from
// members, so they return null — which the sync turns into "clear our own
// link if it's there", never "clear whatever is there" (see isOwnTopUpUrl).
//
// Pure: host arithmetic via services/fund/host.ts (same scheme/port logic as
// every other cross-host fund link — https in production, http + PORT in dev,
// `acme.lacaisse.eu` rewritten to `acme.localhost` off the prod apex).
export const TOP_UP_SERIAL_PLACEHOLDER = "{serial}";

export function topUpUrlFor(fund: {
  domain: string;
  allocationMode: AllocationMode;
}): string | null {
  if (fund.allocationMode === "DISABLED") return null;
  return ownTopUpUrl(fund.domain);
}

function ownTopUpUrl(domain: string): string {
  return `${getFundUrl(domain)}/pay/${TOP_UP_SERIAL_PLACEHOLDER}`;
}

/**
 * Whether `url` is a top-up link La Caisse published for this fund — its own
 * `/pay/{serial}` page, as this environment builds it or in its production
 * https form. Only such a link may be cleared when a fund turns DISABLED: a
 * treasury can carry a value CitizenPay manages itself (Brussels Pay points
 * at CP's own checkout), and a fund that takes no money through La Caisse has
 * no business removing it.
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
