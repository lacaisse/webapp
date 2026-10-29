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

import { auth } from "@/services/auth/better-auth";
import { prisma } from "@/services/db/prisma";
import {
  getApexUrl,
  getCurrentFund,
  getCurrentFundDomain,
  getFundUrl,
} from "@/services/fund/server";
import { getHostType } from "@/services/host/server";

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
// The apex is seeded from config at boot; fund hosts get their row the first
// time a client fetches their protected-resource metadata — which every MCP
// client does before its first authorize — see ensureMcpResource below.

export type AccessTokenClaims = Awaited<
  ReturnType<typeof verifyAccessTokenRequest>
>;

/**
 * The resource identifier for the current request's host, or null on the
 * auth host (which serves the authorization server, not an MCP server).
 */
export async function currentMcpResource(): Promise<string | null> {
  const hostType = await getHostType();
  if (hostType === "auth") return null;
  const fundDomain = await getCurrentFundDomain();
  const origin =
    hostType === "fund" && fundDomain ? getFundUrl(fundDomain) : getApexUrl("");
  return mcpResourceForOrigin(origin);
}

/**
 * Idempotently register `resource` with the authorization server. Rows are
 * never updated afterwards (same `insertOnly` semantics as the plugin's own
 * config seeding) so an admin edit in the DB sticks.
 */
export async function ensureMcpResource(
  resource: string,
  name: string,
): Promise<void> {
  const now = new Date();
  await prisma.oauthResource.upsert({
    where: { identifier: resource },
    create: {
      identifier: resource,
      name,
      allowedScopes: MCP_SCOPES,
      createdAt: now,
      updatedAt: now,
    },
    update: {},
    select: { id: true },
  });
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
  const headers = new Headers(challenge.headers);
  headers.set("Content-Type", "application/json");
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32000, message: challenge.message },
      id: null,
    }),
    { status: challenge.statusCode, headers },
  );
}

function jsonRpcError(status: number, message: string): Response {
  return Response.json(
    { jsonrpc: "2.0", error: { code: -32000, message }, id: null },
    { status },
  );
}
