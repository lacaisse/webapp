// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import type { FundRole } from "@/services/db/generated/enums";
import { prisma } from "@/services/db/prisma";
import { hasMinFundRole } from "@/services/auth/roles";
import { toCanonicalFundDomain } from "@/services/fund/host";

// Fund authorization for MCP tool calls.
//
// The endpoint is mounted on every host, and servers are normally registered
// at a FUND url (`https://<fund-domain>/api/mcp`) — so proxy.ts has already
// resolved the fund and forwarded `x-fund-domain`, exactly like a dashboard
// page. `requireFundForTool` uses that as the default, which is why tools take
// `fund` as an OPTIONAL argument.
//
// It stays overridable (and is required when the server is registered on the
// apex, which belongs to no fund) — safe only because the membership check
// below is the real tenant gate: the token's user must hold at least `minRole`
// in whichever fund is resolved or the call fails. Every tool goes through here
// before touching fund data; none may query by a raw fundId from input.

export class McpToolError extends Error {}

/** What every tool handler is closed over: the token's user + the host fund. */
export type ToolContext = {
  userId: string;
  /** Fund domain from the request host; null on the apex / auth hosts. */
  fundDomain: string | null;
};

/**
 * Resolve the fund a tool call is about — the explicit `fund` argument when
 * given, otherwise the fund this MCP server is connected to — and authorize
 * the token's user against it.
 */
export async function requireFundForTool(
  ctx: ToolContext,
  fundArg: string | undefined,
  minRole: FundRole,
) {
  const domain = fundArg?.trim() || ctx.fundDomain;
  if (!domain) {
    throw new McpToolError(
      "No fund in scope: this MCP server is connected to the apex host, which belongs to no fund. Pass `fund` (list_funds returns the domains you can use), or reconnect to https://<fund-domain>/api/mcp.",
    );
  }
  return requireFundAccessForUser(ctx.userId, domain, minRole);
}

export async function requireFundAccessForUser(
  userId: string,
  fundDomain: string,
  minRole: FundRole,
) {
  const appDomain = process.env.APP_DOMAIN ?? "localhost";
  // Accept the dev host form (acme.localhost) as well as the canonical
  // domain stored on Fund.domain (acme.lacaisse.eu).
  const domain = toCanonicalFundDomain(
    fundDomain.trim().toLowerCase().split(":")[0]!,
    appDomain,
  );

  const fund = await prisma.fund.findUnique({ where: { domain } });
  if (!fund) {
    throw new McpToolError(`No fund found for domain "${fundDomain}".`);
  }

  const membership = await prisma.fundMember.findUnique({
    where: { userId_fundId: { userId, fundId: fund.id } },
  });
  if (!membership || !hasMinFundRole(membership.role, minRole)) {
    throw new McpToolError(
      `You need at least the ${minRole} role in ${fund.name} for this tool.`,
    );
  }

  return { fund, membership };
}
