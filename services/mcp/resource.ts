// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure helpers describing the MCP server as an OAuth protected resource
// (RFC 8707 / RFC 9728). No headers, no DB — importable from the auth config
// and from unit tests. The request-bound side lives in ./auth.ts.

/** Where the MCP endpoint lives on every host. */
export const MCP_PATH = "/api/mcp";

/**
 * OAuth scopes the authorization server issues for MCP. The tools don't
 * gate on scopes (tenancy is the user's FundMember row, see ./authz.ts) —
 * `offline_access` is what turns a grant into a refresh token, the rest are
 * the OIDC identity scopes MCP clients ask for by default.
 */
export const MCP_SCOPES = ["openid", "profile", "email", "offline_access"];

/**
 * The protected-resource identifier for an MCP server hosted at `origin`:
 * the exact URL agents connect to, which is also the JWT `aud` of every
 * access token minted for it. One per host — the apex and each fund domain.
 */
export function mcpResourceForOrigin(origin: string): string {
  return `${origin.replace(/\/+$/, "")}${MCP_PATH}`;
}

/**
 * RFC 9728 well-known path. Clients probe both the bare path and the
 * path-inserted alias (`/.well-known/oauth-protected-resource/api/mcp`), the
 * latter being what the 401 challenge points at.
 */
export const PROTECTED_RESOURCE_METADATA_PATH =
  "/.well-known/oauth-protected-resource";
