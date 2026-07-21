// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

import { registerTools } from "./tools";

// One MCP server instance per request (stateless Streamable HTTP): no session
// ids, plain JSON responses, nothing held in memory between calls — exactly
// what a serverless deployment wants. Auth happened before we get here
// (withMcpAuth in app/api/mcp/route.ts); the token's userId scopes every tool.

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

  const server = new McpServer({ name: "lacaisse", version: "1.0.0" });
  registerTools(server, { userId: token.userId });

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(req);
}
