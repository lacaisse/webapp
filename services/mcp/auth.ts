// SPDX-License-Identifier: AGPL-3.0-or-later
import "server-only";

import { createResourceServerChallenge } from "@better-auth/oauth-provider";
import {
  DPOP_SIGNING_ALGORITHMS,
  createDpopReplayStore,
  isInsufficientScopeError,
  requestToResourceInput,
  verifyAccessTokenRequest,
} from "better-auth/oauth2";

import { headers } from "next/headers";

import { auth } from "@/services/auth/better-auth";
import { prisma } from "@/services/db/prisma";
import { getApexUrl, getCurrentFund, getFundUrl } from "@/services/fund/server";

import { MCP_SCOPES, mcpResourceForOrigin } from "./resource";

// The MCP endpoint is a per-host OAuth protected resource. Agents register a
// server at a fund's own URL (`https://<fund-domain>/api/mcp`), so the
// resource identifier — the JWT `aud` the authorization server binds every
// access token to — is that URL, derived from the proxy-validated host
// exactly the way page links are (getFundUrl / getApexUrl), never from the
// raw Host header.
//
// This is why we don't use `requireMcpAuth` from @better-auth/mcp: it takes
// ONE static resource per auth instance (and rejects `*.localhost` dev hosts
// as non-loopback). We compose the same public building blocks it uses —
// verifyAccessTokenRequest (signature, issuer, audience, expiry, DPoP) and
// createResourceServerChallenge (the RFC 9728 401 / RFC 6750 403 challenge)
// — around a resource resolved per request.
//
// Every resource must exist as an OauthResource row before the authorization
// server will put it in a token's audience (`invalid_target` otherwise).
// The apex is seeded from config at boot; a fund's row is created with the
// fund (services/fund/actions.ts → registerFundMcpResource), the backfill
// migration covers older funds, and the protected-resource metadata route
// re-creates it on the way as a fallback (ensureMcpResource).

export type AccessTokenClaims = Awaited<
  ReturnType<typeof verifyAccessTokenRequest>
>;

/**
 * The resource identifier for the current request's host, or null where
 * there is no MCP server: the auth host (it serves the authorization
 * server), a host the proxy could not classify, and the reserved infra
 * subdomains (`www.`, `api.`, …) that proxy.ts folds into "apex" — the
 * resource must be the exact origin the agent connected to, and a token
 * minted for the apex must not be accepted elsewhere. Reads the proxy's
 * raw classification rather than getHostType(), whose unknown-host
 * fallback is "apex".
 */
export async function currentMcpResource(): Promise<string | null> {
  const h = await headers();
  const hostType = h.get("x-host-type");
  if (hostType === "fund") {
    const fundDomain = h.get("x-fund-domain");
    return fundDomain ? mcpResourceForOrigin(getFundUrl(fundDomain)) : null;
  }
  if (hostType !== "apex") return null;
  // An equality check against the configured apex, not host parsing: the
  // reserved subdomains carry the same x-host-type and nothing else tells
  // them apart.
  const requestHost = (h.get("host") ?? "").split(":")[0];
  if (requestHost !== (process.env.APP_DOMAIN ?? "localhost")) return null;
  return mcpResourceForOrigin(getApexUrl(""));
}

/**
 * Register a fund's MCP resource the moment the fund (and so its host)
 * exists, so the first authorize that names it never sees `invalid_target`.
 * Best-effort: a failure here must not fail fund creation — the discovery
 * route repairs it on the agent's first visit.
 */
export async function registerFundMcpResource(fund: {
  domain: string;
  name: string;
}): Promise<void> {
  try {
    await ensureMcpResource(mcpResourceForOrigin(getFundUrl(fund.domain)), fund.name);
  } catch (e) {
    console.error("registerFundMcpResource failed:", e);
  }
}

/**
 * Idempotently register `resource` with the authorization server. Read
 * first — the public discovery route calls this on every hit — and create
 * only when missing; rows are never updated afterwards (same `insertOnly`
 * semantics as the plugin's own config seeding) so an admin edit sticks.
 */
export async function ensureMcpResource(
  resource: string,
  name: string,
): Promise<void> {
  const existing = await prisma.oauthResource.findUnique({
    where: { identifier: resource },
    select: { id: true },
  });
  if (existing) return;
  const now = new Date();
  try {
    await prisma.oauthResource.create({
      data: {
        identifier: resource,
        name,
        allowedScopes: MCP_SCOPES,
        createdAt: now,
        updatedAt: now,
      },
      select: { id: true },
    });
  } catch (e) {
    // P2002: a concurrent request created it between the read and the
    // insert — that's the row we wanted.
    if ((e as { code?: string }).code !== "P2002") throw e;
  }
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, MCP-Protocol-Version",
  "Access-Control-Max-Age": "86400",
};

/** Browser-based MCP clients (the Inspector) fetch discovery cross-origin. */
export function discoveryPreflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * RFC 9728 protected-resource metadata for the current host. Registers the
 * host's resource on the way, so the authorize request that follows can
 * target it.
 */
export async function protectedResourceMetadata(): Promise<Response> {
  const resource = await currentMcpResource();
  if (!resource) return new Response(null, { status: 404 });

  const fund = await getCurrentFund();
  await ensureMcpResource(resource, fund?.name ?? "La Caisse");

  const { baseURL } = await auth.$context;
  return Response.json(
    {
      resource,
      authorization_servers: [baseURL],
      bearer_methods_supported: ["header"],
      scopes_supported: MCP_SCOPES,
      dpop_signing_alg_values_supported: [...DPOP_SIGNING_ALGORITHMS],
    },
    {
      headers: {
        ...CORS_HEADERS,
        "Cache-Control":
          "public, max-age=15, stale-while-revalidate=15, stale-if-error=86400",
      },
    },
  );
}

type McpHandler = (
  request: Request,
  claims: AccessTokenClaims,
) => Promise<Response>;

/**
 * Protect an MCP route handler with the host's resource. Verifies the bearer
 * (or DPoP-bound) access token against the authorization server's JWKS —
 * signature, issuer, audience = this host's resource, expiry — and hands the
 * verified claims to `handler`. Anything else gets the JSON-RPC 401 with the
 * `WWW-Authenticate` header MCP clients use to start (or redo) authorization.
 */
export function requireMcpAuthForHost(handler: McpHandler) {
  return async (request: Request): Promise<Response> => {
    const resource = await currentMcpResource();
    if (!resource) {
      return jsonRpcError(404, "No MCP server on this host");
    }

    // The issuer is the auth host's Better Auth base URL (with /api/auth) —
    // what the jwt plugin stamps as `iss` and what the authorization-server
    // metadata advertises. JWKS is served by the same plugin under it.
    const { baseURL, internalAdapter } = await auth.$context;

    let claims: AccessTokenClaims;
    try {
      claims = await verifyAccessTokenRequest(requestToResourceInput(request), {
        verifyOptions: {
          issuer: baseURL,
          audience: resource,
          requiredClaims: ["azp"],
        },
        jwksUrl: `${baseURL}/jwks`,
        dpop: {
          // DB-backed replay store so anti-replay holds across serverless
          // instances (same default requireMcpAuth picks).
          replayStore: createDpopReplayStore(internalAdapter),
        },
      });
    } catch (error) {
      return challengeResponse(error, resource);
    }

    try {
      return await handler(request, claims);
    } catch (error) {
      if (isInsufficientScopeError(error)) {
        return challengeResponse(error, resource);
      }
      throw error;
    }
  };
}

function challengeResponse(error: unknown, resource: string): Response {
  const challenge = createResourceServerChallenge(error, resource, {
    challengeScopes: MCP_SCOPES,
    dpopSigningAlgorithms: DPOP_SIGNING_ALGORITHMS,
  });
  // Not an auth failure (e.g. the JWKS fetch blew up) — let the route 500.
  if (!challenge) throw error;
  return jsonRpcError(challenge.statusCode, challenge.message, challenge.headers);
}

function jsonRpcError(
  status: number,
  message: string,
  extraHeaders?: HeadersInit,
): Response {
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32000, message }, id: null },
    { status, headers: extraHeaders },
  );
}
