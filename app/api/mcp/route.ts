// SPDX-License-Identifier: AGPL-3.0-or-later
import { requireMcpAuthForHost } from "@/services/mcp/auth";
import { handleMcpRequest } from "@/services/mcp/handler";

// The MCP endpoint agents connect to (Streamable HTTP transport). Mounted on
// every host like the rest of app/api; a server is registered at the fund's
// own URL (`https://<fund-domain>/api/mcp`), the apex being the fund-less
// fallback.
//
// Authorization is OAuth 2.1 via @better-auth/mcp: requireMcpAuthForHost
// verifies the bearer JWT against the auth host's JWKS with this host's URL
// as the expected audience, and 401s with a WWW-Authenticate header pointing
// at the protected-resource metadata, which walks the client through
// discovery → dynamic registration → user login + consent on the auth host →
// short-lived token. See the MCP section in AGENTS.md.

// list_transfers is capped per call, but a full 1000-row page still resolves a
// timestamp per block behind the scenes — comfortably more than the platform
// default allows. Callers iterate with the cursor; each iteration needs room
// to finish.
export const maxDuration = 60;

const handler = requireMcpAuthForHost((req, claims) =>
  handleMcpRequest(req, {
    // `sub` is the user id for a user grant. A client_credentials token has
    // no user behind it (its subject is the client itself) — the handler
    // refuses those, nothing in the toolset is meaningful without a member.
    userId:
      typeof claims.sub === "string" && claims.sub !== claims.azp
        ? claims.sub
        : null,
  }),
);

export { handler as GET, handler as POST, handler as DELETE };
