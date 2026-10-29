// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure helpers for the OAuth provider's signed `oauth_query` (no headers, no
// DB — shared by the login form in the browser and the server actions).
//
// When an MCP client's authorize request needs the user (no session, or
// `prompt=login`), @better-auth/mcp redirects the browser to the auth host's
// `/login?<signed query>` — the original authorize parameters plus `exp`,
// `ba_iat`, `ba_param` (the signed parameter names) and `sig`. To resume,
// that exact string goes back as `oauth_query` in the sign-in body: the
// plugin verifies the signature, finishes the authorize inside the sign-in
// call and answers with the next redirect (consent page or the client's
// redirect_uri). Same mechanism for the consent page, which receives the
// signed query too.

/** Parameters the plugin adds when it signs an authorize query. */
const SIGNATURE_PARAMS = ["sig", "exp", "ba_iat", "ba_pl", "ba_param"];

/**
 * `location.search` (or the proxy's `x-search`) → the signed query string,
 * or null when the page wasn't reached from an authorize redirect. Only the
 * presence of a signature is checked here; the server verifies it.
 */
export function signedOAuthQueryFromSearch(
  search: string | null | undefined,
): string | null {
  if (!search) return null;
  const query = search.startsWith("?") ? search.slice(1) : search;
  const params = new URLSearchParams(query);
  return params.has("sig") && params.has("client_id") ? query : null;
}

/**
 * The next hop if a resumed `auth.api.*` call's result carries one: either
 * the plain `{ redirect: true, url }` object, or (what `auth.api.oauth2Consent`
 * hands back when its nested authorize dispatch builds the reply itself) a
 * `Response` — a 3xx with `location`, or a JSON body with the same object.
 */
export async function oauthRedirectFrom(
  result: unknown,
): Promise<string | null> {
  let value: unknown = result;
  if (result instanceof Response) {
    const location = result.headers.get("location");
    if (location) return location;
    value = await result
      .clone()
      .json()
      .catch(() => null);
  }
  if (
    value &&
    typeof value === "object" &&
    "redirect" in value &&
    value.redirect === true &&
    "url" in value &&
    typeof value.url === "string"
  ) {
    return value.url;
  }
  return null;
}

/**
 * Where to send the browser to resume an authorize after a sign-in that did
 * NOT carry `oauth_query` (the passkey ceremony — its request body is owned by
 * the passkey plugin). Re-entering /oauth2/authorize with the original
 * parameters and the fresh session cookie continues the flow exactly as the
 * sign-in hook would: consent if needed, then the code redirect. The
 * signature params are dropped (authorize doesn't take them) and a satisfied
 * `prompt=login` too, so it can't loop back to the login page.
 */
export function authorizeResumeUrl(signedQuery: string): string {
  const params = new URLSearchParams(signedQuery);
  for (const name of SIGNATURE_PARAMS) params.delete(name);
  const prompt = params
    .get("prompt")
    ?.split(" ")
    .filter((value) => value && value !== "login");
  if (prompt?.length) params.set("prompt", prompt.join(" "));
  else params.delete("prompt");
  return `/api/auth/oauth2/authorize?${params.toString()}`;
}
