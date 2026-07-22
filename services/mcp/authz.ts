// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import type { FundRole } from "@/services/db/generated/enums";
import { prisma } from "@/services/db/prisma";
import { hasMinFundRole } from "@/services/auth/roles";
import { toCanonicalFundDomain } from "@/services/fund/host";

// Fund authorization for MCP tool calls.
//
// ⚠️ Deliberate deviation from the DAL: dashboard pages derive the fund from
// the request HOST (proxy.ts headers) and never accept a fund from the
// client. MCP requests all arrive on one endpoint with a bearer token, so
// the fund is a tool PARAMETER instead — which is safe only because the
// membership check below is the tenant gate: the token's user must hold at
// least `minRole` in the named fund or the call fails. Every tool goes
// through here before touching fund data; none may query by a raw fundId
// from input.

export class McpToolError extends Error {}

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
