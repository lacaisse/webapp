// SPDX-License-Identifier: AGPL-3.0-or-later
import { withMcpAuth } from "better-auth/plugins";

import { auth } from "@/services/auth/better-auth";
import { handleMcpRequest } from "@/services/mcp/handler";

// The MCP endpoint agents connect to (Streamable HTTP transport). Mounted on
// every host like the rest of app/api, but the canonical URL is the apex:
//   https://<APP_DOMAIN>/api/mcp
//
// Authorization is OAuth 2.1 via the Better Auth `mcp` plugin: withMcpAuth
// verifies the bearer token against OauthAccessToken and 401s with a
// WWW-Authenticate header pointing at the protected-resource metadata, which
// walks the client through discovery → dynamic registration → user login on
// the auth host → short-lived token. See the MCP section in AGENTS.md.

// list_transfers is capped per call, but a full 1000-row page still resolves a
// timestamp per block behind the scenes — comfortably more than the platform
// default allows. Callers iterate with the cursor; each iteration needs room
// to finish.
export const maxDuration = 60;

const handler = withMcpAuth(auth, (req, token) => handleMcpRequest(req, token));

export { handler as GET, handler as POST, handler as DELETE };
