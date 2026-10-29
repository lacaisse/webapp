// SPDX-License-Identifier: AGPL-3.0-or-later
import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";

import { auth } from "@/services/auth/better-auth";
import { discoveryPreflight } from "@/services/mcp/auth";

// RFC 8414 §3.1: for an issuer with a path (`…/api/auth`) the metadata lives
// at `/.well-known/oauth-authorization-server/api/auth`. This is the first
// URL MCP clients probe.

export const GET = oauthProviderAuthServerMetadata(auth, {
  headers: { "Access-Control-Allow-Origin": "*" },
});
export const OPTIONS = discoveryPreflight;
