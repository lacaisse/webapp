// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";
import { verifyOAuthQueryParams } from "@better-auth/oauth-provider";
import { isAPIError } from "better-auth/api";
import { headers } from "next/headers";
import { signedOAuthQueryFromSearch } from "./oauth-query";
import { auth } from "./better-auth";

// Server side of the MCP OAuth login/consent resume (the pure parts are in
// ./oauth-query.ts). The provider plugin answers a resumed authorize in one
// of two shapes depending on how it classifies the caller:
//   - `{ redirect: true, url }` (plain, or wrapped in a JSON `Response`)
//     when it thinks it's talking to fetch/JSON — what a Server Action's
//     request looks like, or when we ask for JSON;
//   - a thrown `APIError("FOUND")` with a `location` header when it thinks
//     it's a browser navigation.
// `oauthRedirectFrom` (in ./oauth-query.ts, pure) / `oauthRedirectFromError`
// extract the next hop from either. The actions hand that URL back to the form as `redirectTo` and
// the browser navigates to it itself (`window.location.assign`) rather than
// through `redirect()`: a server-action redirect is a soft client-side
// navigation, and under Cache Components the dynamic /consent page cannot
// be prerendered for one — it rendered the not-found shell. The hops are
// cross-page (and the last one cross-origin) anyway; a full navigation is
// what an OAuth redirect is.

/**
 * The signed authorize query the current page was reached with (via the
 * proxy's `x-search`), verified against the auth secret — or null. Pages
 * under app/(auth-host) use this to tell "mid-OAuth" from a plain visit.
 */
export async function readSignedOAuthQuery(): Promise<string | null> {
  const h = await headers();
  const query = signedOAuthQueryFromSearch(h.get("x-search"));
  if (!query) return null;
  const { secret } = await auth.$context;
  return (await verifyOAuthQueryParams(query, secret)) ? query : null;
}

/**
 * Call context for an `auth.api.*` call that resumes an OAuth flow. Two
 * things the plugin's authorize needs that a Server Action call lacks:
 *   - a `request` object (it refuses to run without one — "request not
 *     found"); a synthetic POST at the endpoint's own URL on the auth host
 *     carrying the incoming headers is all it reads from it;
 *   - `Accept: application/json`, so the next hop comes back as
 *     `{ redirect, url }` instead of a thrown navigation.
 */
export async function oauthResumeCallContext(
  endpointPath: string,
): Promise<{ headers: Headers; request: Request }> {
  const h = new Headers(await headers());
  h.set("accept", "application/json");
  const { baseURL } = await auth.$context;
  const request = new Request(`${baseURL}${endpointPath}`, {
    method: "POST",
    headers: h,
  });
  return { headers: h, request };
}

/**
 * The next hop from the plugin's thrown navigation redirect
 * (`APIError("FOUND")` + `location`), or null for any other error —
 * treating a resume redirect as a credential failure would eat the agent's
 * authorization code. Duck-typed via `isAPIError`: the provider plugin
 * throws better-call's base APIError, not better-auth's subclass, so an
 * `instanceof` on the latter misses it.
 */
export function oauthRedirectFromError(e: unknown): string | null {
  if (!isAPIError(e) || e.status !== "FOUND") return null;
  return e.headers ? new Headers(e.headers).get("location") : null;
}
