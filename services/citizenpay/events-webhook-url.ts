// SPDX-License-Identifier: AGPL-3.0-or-later
import { getFundUrl } from "@/services/fund/host";

// Where Citizen Pay posts the fund's treasury events: the receiver at
// app/api/citizenpay/events on the fund's own host, so the proxy identifies
// the fund and the url is one the api's allowlist (the La Caisse apex or the
// fund's registered domain) accepts. Pure host arithmetic, like the top-up
// URL (services/citizenpay/top-up-url.ts).

export const EVENTS_WEBHOOK_PATH = "/api/citizenpay/events";

export function eventsWebhookUrlFor(fund: { domain: string }): string {
  return `${getFundUrl(fund.domain)}${EVENTS_WEBHOOK_PATH}`;
}

/**
 * Whether the url may be registered with a real Citizen Pay treasury: the api
 * accepts https only, and a dev host (`http://acme.localhost:3033/…`) or a
 * prod domain built without NODE_ENV=production never should be.
 */
export function isPublishableEventsWebhookUrl(url: string): boolean {
  return url.startsWith("https://");
}
