// SPDX-License-Identifier: AGPL-3.0-or-later
import { createHash } from "node:crypto";

// Pure configuration of the OAuth 2.1 authorization server (the
// `@better-auth/mcp` preset of `@better-auth/oauth-provider`) — no Prisma, no
// Next request context, so the unit test of the wallet flow
// (services/auth/wallet-oauth.test.ts) can stand up a Better Auth instance on
// the memory adapter with exactly the options production runs.
//
// Two kinds of clients share the one server:
//   - MCP agents (dynamic registration, consent, 1 h access / 1 day refresh
//     through the per-resource TTL on every `/api/mcp` resource);
//   - the Citizen Pay card wallet (tap.citizenpay.eu), a static confidential
//     first-party client (plan "Bread card-holder voting", D5) that logs a
//     fund MEMBER in and calls the Citizen Pay api with the resulting JWT:
//     consent skipped, PKCE required, 15 min access tokens (per-resource TTL
//     on the api's resource), 30 day rotating refresh tokens (the provider
//     default below — a resource TTL can only shorten the default, never
//     extend it, which is why the default moves to 30 days and the MCP
//     resources pin themselves back to one day).
//
// What the api receives (plan §7, "Member auth middleware"):
//   access token  JWT, `iss` = the auth host's Better Auth base URL
//                 (`https://auth.<APP_DOMAIN>/api/auth`), `sub` = User.id,
//                 `aud` = the api URL (RFC 8707 `resource`), `email` +
//                 `email_verified` (customAccessTokenClaims), `scope`,
//                 `client_id`, `exp` = iat + 900. Signed with the jwt plugin's
//                 key (EdDSA / Ed25519 by default), JWKS at
//                 `<iss>/jwks`.
//   id token      carries `auth_time` (the session's creation time; a
//                 refresh keeps it). The provider reserves `auth_time` on
//                 access tokens and never stamps it there, so freshness for
//                 the PIN step-up is proven with the ID token (`X-Id-Token`).
//   `prompt=login max_age=N` forces a new credential entry; the new session
//                 gives a new `auth_time`.

export const WALLET_CLIENT_ID = "citizenpay-wallet";

/** The card wallet (the OAuth client; where members see their cards). */
export const WALLET_URL = "https://tap.citizenpay.eu";

/** The scopes every client of this server may ask for. */
export const OAUTH_SCOPES = ["openid", "profile", "email", "offline_access"];

export const WALLET_ACCESS_TOKEN_TTL = 15 * 60; // 15 min, via the api resource's accessTokenTtl
export const WALLET_REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60; // 30 days = the provider default below
export const MCP_ACCESS_TOKEN_TTL = 60 * 60; // 1 h — the provider default, unchanged for agents
export const MCP_REFRESH_TOKEN_TTL = 24 * 60 * 60; // 1 day, pinned per /api/mcp resource

/** Redirect URIs the wallet client is registered with when the env names none. */
export const WALLET_DEFAULT_REDIRECT_URIS = [
  "https://tap.citizenpay.eu/auth/callback",
  // Staging / preview wallet. Replace or extend through WALLET_OAUTH_REDIRECT_URIS.
  "https://tap.citizenpay.xyz/auth/callback",
  // Local bench: the provider matches loopback redirects on every port
  // (RFC 8252 §7.3), so one entry covers any local wallet.
  "http://localhost:3000/auth/callback",
];

export type WalletClientConfig = {
  /** The confidential client's secret, as the wallet sends it (client_secret_basic). */
  clientSecret: string;
  redirectUris: string[];
  /** RFC 8707 resource = JWT `aud`: the Citizen Pay api URL (its MEMBER_AUTH_AUDIENCE). */
  audience: string;
};

/**
 * The wallet client from the environment, or null when it is not configured
 * (then the client is simply not registered and the wallet cannot log anyone
 * in — MCP is unaffected).
 *   WALLET_OAUTH_CLIENT_SECRET   required; the wallet holds the same value
 *   CITIZENPAY_API_AUDIENCE      required; e.g. https://api2.citizenpay.xyz
 *   WALLET_OAUTH_REDIRECT_URIS   optional, comma-separated, replaces the defaults
 */
export function walletClientConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): WalletClientConfig | null {
  const clientSecret = env.WALLET_OAUTH_CLIENT_SECRET?.trim();
  const audience = env.CITIZENPAY_API_AUDIENCE?.trim();
  if (!clientSecret || !audience) return null;
  const fromEnv = (env.WALLET_OAUTH_REDIRECT_URIS ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  return {
    clientSecret,
    audience: audience.replace(/\/+$/, ""),
    redirectUris: fromEnv.length > 0 ? fromEnv : WALLET_DEFAULT_REDIRECT_URIS,
  };
}

/**
 * How the provider stores a client secret with `storeClientSecret: "hashed"`
 * (its default with the jwt plugin): SHA-256 of the UTF-8 secret, base64url
 * without padding. Mirrors the plugin's `defaultHasher`, which it does not
 * export — the unit test pins the two together.
 */
export function hashClientSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("base64url");
}

/** The OauthClient row of the wallet, as the plugin's `getClient` reads it. */
export function walletOauthClientRow(cfg: WalletClientConfig, now = new Date()) {
  return {
    clientId: WALLET_CLIENT_ID,
    clientSecret: hashClientSecret(cfg.clientSecret),
    name: "Citizen Pay wallet",
    uri: WALLET_URL,
    redirectUris: cfg.redirectUris,
    scopes: OAUTH_SCOPES,
    grantTypes: ["authorization_code", "refresh_token"],
    responseTypes: ["code"],
    tokenEndpointAuthMethod: "client_secret_basic",
    applicationType: "web",
    requirePKCE: true,
    // First-party: no consent screen (plan Q19, default yes).
    skipConsent: true,
    disabled: false,
    dpopBoundAccessTokens: false,
    contacts: [] as string[],
    postLogoutRedirectUris: [] as string[],
    clientCredentialsScopes: [] as string[],
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * The OauthResource row of the Citizen Pay api: the audience of every wallet
 * access token, with the 15 min TTL. `refreshTokenTtl` null = the provider
 * default (30 days).
 */
export function walletAudienceResourceRow(cfg: WalletClientConfig, now = new Date()) {
  return {
    identifier: cfg.audience,
    name: "Citizen Pay api",
    allowedScopes: OAUTH_SCOPES,
    accessTokenTtl: WALLET_ACCESS_TOKEN_TTL,
    refreshTokenTtl: null as number | null,
    disabled: false,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Extra claims on every JWT access token. `email` is what the api matches a
 * wallet token to its holder records with (next to `sub`); `email_verified`
 * lets it refuse an unverified login up front. Reserved names (`sub`, `aud`,
 * `auth_time`, …) are the provider's own and would be stripped here.
 */
export function memberAccessTokenClaims(user: {
  email: string;
  emailVerified: boolean;
} | null | undefined): Record<string, unknown> {
  if (!user) return {};
  return { email: user.email, email_verified: user.emailVerified };
}

/**
 * The provider options shared by production (services/auth/better-auth.ts)
 * and the wallet flow test. `mcpResource` is the apex MCP resource the
 * preset seeds at boot.
 */
export function oauthProviderOptions(args: { mcpResource: string }) {
  return {
    loginPage: "/login",
    consentPage: "/consent",
    resource: args.mcpResource,
    // Prisma can't store a resource without allowedScopes (null list). The
    // MCP resource keeps one-day refresh tokens through its own TTL.
    resources: [
      {
        identifier: args.mcpResource,
        allowedScopes: OAUTH_SCOPES,
        refreshTokenTtl: MCP_REFRESH_TOKEN_TTL,
      },
    ],
    scopes: OAUTH_SCOPES,
    enforcePerClientResources: false,
    accessTokenExpiresIn: MCP_ACCESS_TOKEN_TTL,
    refreshTokenExpiresIn: WALLET_REFRESH_TOKEN_TTL,
    codeExpiresIn: 600,
    allowDynamicClientRegistration: true,
    allowUnauthenticatedClientRegistration: true,
    // Cursor / older Claude Code omit application_type; their loopback
    // redirect URIs make them native clients, not web ones.
    clientRegistrationDefaultApplicationType: "infer" as const,
    customAccessTokenClaims: ({
      user,
    }: {
      user?: { email: string; emailVerified: boolean } | null;
    }) => memberAccessTokenClaims(user),
  };
}

/**
 * The upsert `update` half of a row: everything but the identity columns
 * (so an existing row keeps its creation time). Shared by the boot-time
 * registration and the script.
 */
export function withoutIdentity<T extends Record<string, unknown>, K extends keyof T>(
  row: T,
  keys: K[],
): Omit<T, K> {
  const out = { ...row };
  for (const key of keys) delete out[key];
  return out;
}
