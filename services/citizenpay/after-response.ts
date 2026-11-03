// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { after } from "next/server";

// Shared by the best-effort pushes to Citizen Pay that run off the response
// path (the top-up URL sync, the events webhook registration).

/** Live api (`CITIZENPAY_API_BASE_URL` set) vs the in-process dev mock. */
export function isLiveCitizenPay(): boolean {
  return Boolean(process.env.CITIZENPAY_API_BASE_URL);
}

const warnedInsecure = new Set<string>();

/**
 * A dev url (`http://acme.localhost:3033/…`) or a prod domain built without
 * NODE_ENV=production is never sent to the live api; say so once per process
 * and per kind of url, not on every request.
 */
export function warnInsecureUrlOnce(what: string, url: string): void {
  if (warnedInsecure.has(what)) return;
  warnedInsecure.add(what);
  console.warn(
    `[citizenpay] not sending a non-https ${what} to the live API (check NODE_ENV / APP_DOMAIN)`,
    url,
  );
}

/**
 * Run `run` after the current response is sent (Next's `after`), so a slow
 * or hung Citizen Pay never stalls a settings save or the connect redirect.
 * Call from a Server Function or Route Handler, after the local write has
 * landed. Never throws: a failure inside is logged, and so is being called
 * outside a request scope (where `after` itself throws).
 */
export function scheduleAfterResponse(
  what: string,
  fundId: string,
  run: () => Promise<unknown>,
): void {
  try {
    after(async () => {
      try {
        await run();
      } catch (e) {
        console.warn(`[citizenpay] ${what} failed`, fundId, e);
      }
    });
  } catch (e) {
    console.warn(`[citizenpay] could not schedule ${what}`, fundId, e);
  }
}
