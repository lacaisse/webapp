// SPDX-License-Identifier: AGPL-3.0-or-later
import { oauthProviderAuthServerMetadata } from "@better-auth/oauth-provider";

import { auth } from "@/services/auth/better-auth";
import { discoveryPreflight } from "@/services/mcp/auth";

// RFC 8414 authorization-server metadata at the root .well-known path. The
// issuer is the auth host's Better Auth base URL (`https://auth.<APP_DOMAIN>/
// api/auth`), so clients first try the path-inserted form served by
// ./api/auth/route.ts and fall back to this one. Better Auth also answers
// under /api/auth/.well-known/* itself.

export const GET = oauthProviderAuthServerMetadata(auth, {
  headers: { "Access-Control-Allow-Origin": "*" },
});
export const OPTIONS = discoveryPreflight;
