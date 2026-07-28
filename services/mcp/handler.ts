// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { getCurrentFund } from "@/services/fund/server";

import { buildInstructions, buildServerInfo } from "./identity";
import { registerTools } from "./tools";

// One MCP server instance per request (stateless Streamable HTTP): no session
// ids, plain JSON responses, nothing held in memory between calls — exactly
// what a serverless deployment wants. Auth happened before we get here
// (withMcpAuth in app/api/mcp/route.ts); the token's userId scopes every tool.
//
// The endpoint is mounted on every host and servers are normally registered at
// a fund URL (`https://<fund-domain>/api/mcp`), so proxy.ts has already
// resolved the fund for us. That one lookup does double duty: the tools take
// their default fund from it (see ./authz.ts) and the server introduces itself
// as that caisse — name, logo, blurb (see ./identity.ts). On the apex there's
// no fund, so both fall back to the platform.

export async function handleMcpRequest(
  req: Request,
  token: { userId?: string | null },
): Promise<Response> {
  if (!token.userId) {
    // Client-credentials tokens carry no user — nothing in this toolset is
    // meaningful without one.
    return Response.json(
      {
        jsonrpc: "2.0",
        error: { code: -32000, message: "Token is not bound to a user" },
        id: null,
      },
      { status: 403 },
    );
  }

  // Null on the apex / auth hosts — every downstream branch treats that as
  // "no fund in scope" rather than an error.
  const fund = await getCurrentFund();

  const server = new McpServer(buildServerInfo(fund), {
    instructions: buildInstructions(fund),
  });
  registerTools(server, {
    userId: token.userId,
    fundDomain: fund?.domain ?? null,
  });

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(req);
}
