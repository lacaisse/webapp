-- better-auth 1.6 → 1.7: the core `mcp` plugin is gone; /api/mcp is now
-- protected by @better-auth/mcp (the OAuth-provider plugin) + jwt(). The
-- plugins own a new set of tables (see the "MCP OAuth provider tables" block
-- in prisma/schema.prisma):
--
--   OauthApplication  → OauthClient (same clientId; rows carried over below)
--   OauthAccessToken  → reshaped (access tokens are JWTs now; old opaque
--                       tokens cannot be verified by 1.7 — dropped)
--   OauthConsent      → reshaped (1.7 consents are bound to the resource the
--                       client asked for, which 1.6 never recorded — dropped,
--                       the user re-consents once per client)
--   new: OauthResource, OauthClientResource, OauthRefreshToken,
--        OauthClientAssertion, Jwks
--
-- Registered MCP clients keep their client_id: an agent whose stored
-- registration predates this migration authorizes again (login + consent)
-- without re-registering. 1.6 stored client secrets in clear; 1.7 stores
-- sha256/base64url hashes (storeClientSecret: "hashed"), so the secret is
-- hashed in place with Postgres' built-in sha256(). A client that presents
-- its secret with a different auth method than the one recorded here gets
-- `invalid_client`, which the MCP SDK answers by re-registering.
--
-- Deploy order: this migration BEFORE the new app version (1.7.3+ validates
-- the Prisma datamodel at startup; the old code never touches the new
-- tables, the new code needs them). Tokens issued by the old app die with
-- the deploy — agents re-authorize on their next call.

-- 1. jwt() plugin key store ---------------------------------------------------
CREATE TABLE "Jwks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "publicKey" TEXT NOT NULL,
    "privateKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "alg" TEXT,
    "crv" TEXT,

    CONSTRAINT "Jwks_pkey" PRIMARY KEY ("id")
);

-- 2. Clients -----------------------------------------------------------------
CREATE TABLE "OauthClient" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clientId" TEXT NOT NULL,
    "clientSecret" TEXT,
    "clientDiscoveryId" TEXT,
    "disabled" BOOLEAN DEFAULT false,
    "skipConsent" BOOLEAN,
    "enableEndSession" BOOLEAN,
    "subjectType" TEXT,
    "scopes" TEXT[],
    "clientCredentialsScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "userId" UUID,
    "createdAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3),
    "name" TEXT,
    "uri" TEXT,
    "icon" TEXT,
    "contacts" TEXT[],
    "tos" TEXT,
    "policy" TEXT,
    "softwareId" TEXT,
    "softwareVersion" TEXT,
    "softwareStatement" TEXT,
    "redirectUris" TEXT[],
    "postLogoutRedirectUris" TEXT[],
    "backchannelLogoutUri" TEXT,
    "backchannelLogoutSessionRequired" BOOLEAN,
    "tokenEndpointAuthMethod" TEXT,
    "applicationType" TEXT,
    "jwks" TEXT,
    "jwksUri" TEXT,
    "grantTypes" TEXT[],
    "responseTypes" TEXT[],
    "requirePKCE" BOOLEAN,
    "dpopBoundAccessTokens" BOOLEAN DEFAULT false,
    "referenceId" TEXT,
    "metadata" JSONB,

    CONSTRAINT "OauthClient_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OauthClient_clientId_key" ON "OauthClient"("clientId");
CREATE INDEX "OauthClient_userId_idx" ON "OauthClient"("userId");

ALTER TABLE "OauthClient" ADD CONSTRAINT "OauthClient_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Carry the 1.6 registrations over. What 1.6 didn't record is filled with
-- the values its registration endpoint answered to clients:
--   - secret: '' meant a public client (token_endpoint_auth_method "none"),
--     anything else a confidential one authenticating with client_secret_basic
--     (what the MCP SDK picks for a client holding a secret);
--   - application type: loopback-http or custom-scheme redirect URIs mean a
--     native client (the "infer" rule DCR applies today), https ones a web app;
--   - scopes / grants / PKCE: 1.7's DCR defaults for a registration without them.
INSERT INTO "OauthClient" (
    "id", "clientId", "clientSecret", "disabled", "userId", "createdAt", "updatedAt",
    "name", "icon", "metadata", "redirectUris", "tokenEndpointAuthMethod",
    "applicationType", "scopes", "grantTypes", "responseTypes", "requirePKCE"
)
SELECT
    a."id",
    a."clientId",
    CASE
        WHEN a."clientSecret" IS NULL OR a."clientSecret" = '' THEN NULL
        ELSE rtrim(translate(encode(sha256(convert_to(a."clientSecret", 'UTF8')), 'base64'), '+/', '-_'), '=')
    END,
    a."disabled",
    a."userId",
    a."createdAt",
    a."updatedAt",
    a."name",
    a."icon",
    CASE WHEN a."metadata" IS NULL OR a."metadata" = '' THEN NULL ELSE a."metadata"::jsonb END,
    ARRAY(SELECT btrim(u) FROM unnest(string_to_array(a."redirectUrls", ',')) AS u WHERE btrim(u) <> ''),
    CASE WHEN a."clientSecret" IS NULL OR a."clientSecret" = '' THEN 'none' ELSE 'client_secret_basic' END,
    CASE
        WHEN EXISTS (
            SELECT 1 FROM unnest(string_to_array(a."redirectUrls", ',')) AS u
            WHERE btrim(u) ~* '^http://(localhost|127\.0\.0\.1|\[::1\])(:|/|$)'
               OR btrim(u) !~* '^https?://'
        ) THEN 'native'
        ELSE 'web'
    END,
    ARRAY['openid', 'profile', 'email', 'offline_access'],
    ARRAY['authorization_code'],
    ARRAY['code'],
    true
FROM "OauthApplication" AS a;

-- 3. Resources (the JWT audience; one row per MCP host) ----------------------
CREATE TABLE "OauthResource" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "identifier" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "accessTokenTtl" INTEGER,
    "refreshTokenTtl" INTEGER,
    "signingAlgorithm" TEXT,
    "signingKeyId" TEXT,
    "allowedScopes" TEXT[],
    "customClaims" JSONB,
    "dpopBoundAccessTokensRequired" BOOLEAN DEFAULT false,
    "disabled" BOOLEAN DEFAULT false,
    "createdAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3),
    "policyVersion" INTEGER DEFAULT 1,
    "metadata" JSONB,

    CONSTRAINT "OauthResource_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OauthResource_identifier_key" ON "OauthResource"("identifier");

-- Every existing fund host, in its production form. The apex resource is
-- seeded by the plugin at boot (from config), and a fund created later gets
-- its row on first discovery (services/mcp/auth.ts::ensureMcpResource) —
-- this backfill only spares the first client of each existing fund that
-- round-trip. Dev databases (hosts under *.localhost) go through the same
-- lazy path and ignore these rows.
INSERT INTO "OauthResource" ("identifier", "name", "allowedScopes", "createdAt", "updatedAt")
SELECT
    'https://' || f."domain" || '/api/mcp',
    f."name",
    ARRAY['openid', 'profile', 'email', 'offline_access'],
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "Fund" AS f
ON CONFLICT ("identifier") DO NOTHING;

CREATE TABLE "OauthClientResource" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clientId" TEXT NOT NULL,
    "resourceId" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3),

    CONSTRAINT "OauthClientResource_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OauthClientResource_clientId_idx" ON "OauthClientResource"("clientId");
CREATE INDEX "OauthClientResource_resourceId_idx" ON "OauthClientResource"("resourceId");
CREATE UNIQUE INDEX "OauthClientResource_clientId_resourceId_key" ON "OauthClientResource"("clientId", "resourceId");

ALTER TABLE "OauthClientResource" ADD CONSTRAINT "OauthClientResource_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "OauthClient"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OauthClientResource" ADD CONSTRAINT "OauthClientResource_resourceId_fkey" FOREIGN KEY ("resourceId") REFERENCES "OauthResource"("identifier") ON DELETE CASCADE ON UPDATE CASCADE;

-- 4. Tokens and consents: 1.6 rows are not carried over --------------------
DROP TABLE "OauthAccessToken";
DROP TABLE "OauthConsent";
DROP TABLE "OauthApplication";

CREATE TABLE "OauthRefreshToken" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "token" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "sessionId" UUID,
    "userId" UUID NOT NULL,
    "referenceId" TEXT,
    "authorizationCodeId" TEXT,
    "resources" TEXT[],
    "requestedUserInfoClaims" TEXT[],
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3),
    "revoked" TIMESTAMP(3),
    "rotatedAt" TIMESTAMP(3),
    "rotationReplayResponse" TEXT,
    "rotationReplayExpiresAt" TIMESTAMP(3),
    "authTime" TIMESTAMP(3),
    "confirmation" JSONB,
    "scopes" TEXT[],

    CONSTRAINT "OauthRefreshToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OauthRefreshToken_token_key" ON "OauthRefreshToken"("token");
CREATE INDEX "OauthRefreshToken_clientId_idx" ON "OauthRefreshToken"("clientId");
CREATE INDEX "OauthRefreshToken_sessionId_idx" ON "OauthRefreshToken"("sessionId");
CREATE INDEX "OauthRefreshToken_userId_idx" ON "OauthRefreshToken"("userId");
CREATE INDEX "OauthRefreshToken_authorizationCodeId_idx" ON "OauthRefreshToken"("authorizationCodeId");

ALTER TABLE "OauthRefreshToken" ADD CONSTRAINT "OauthRefreshToken_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "OauthClient"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OauthRefreshToken" ADD CONSTRAINT "OauthRefreshToken_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OauthRefreshToken" ADD CONSTRAINT "OauthRefreshToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "OauthAccessToken" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "token" TEXT,
    "clientId" TEXT NOT NULL,
    "sessionId" UUID,
    "userId" UUID,
    "referenceId" TEXT,
    "authorizationCodeId" TEXT,
    "resources" TEXT[],
    "requestedUserInfoClaims" TEXT[],
    "refreshId" UUID,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3),
    "revoked" TIMESTAMP(3),
    "confirmation" JSONB,
    "scopes" TEXT[],

    CONSTRAINT "OauthAccessToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OauthAccessToken_token_key" ON "OauthAccessToken"("token");
CREATE INDEX "OauthAccessToken_clientId_idx" ON "OauthAccessToken"("clientId");
CREATE INDEX "OauthAccessToken_sessionId_idx" ON "OauthAccessToken"("sessionId");
CREATE INDEX "OauthAccessToken_userId_idx" ON "OauthAccessToken"("userId");
CREATE INDEX "OauthAccessToken_authorizationCodeId_idx" ON "OauthAccessToken"("authorizationCodeId");
CREATE INDEX "OauthAccessToken_refreshId_idx" ON "OauthAccessToken"("refreshId");

ALTER TABLE "OauthAccessToken" ADD CONSTRAINT "OauthAccessToken_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "OauthClient"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OauthAccessToken" ADD CONSTRAINT "OauthAccessToken_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "OauthAccessToken" ADD CONSTRAINT "OauthAccessToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OauthAccessToken" ADD CONSTRAINT "OauthAccessToken_refreshId_fkey" FOREIGN KEY ("refreshId") REFERENCES "OauthRefreshToken"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "OauthConsent" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "clientId" TEXT NOT NULL,
    "userId" UUID,
    "referenceId" TEXT,
    "resources" TEXT[],
    "requestedUserInfoClaims" TEXT[],
    "scopes" TEXT[],
    "createdAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3),

    CONSTRAINT "OauthConsent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "OauthConsent_clientId_idx" ON "OauthConsent"("clientId");
CREATE INDEX "OauthConsent_userId_idx" ON "OauthConsent"("userId");

ALTER TABLE "OauthConsent" ADD CONSTRAINT "OauthConsent_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "OauthClient"("clientId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OauthConsent" ADD CONSTRAINT "OauthConsent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 5. private_key_jwt assertion replay guard ----------------------------------
CREATE TABLE "OauthClientAssertion" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OauthClientAssertion_pkey" PRIMARY KEY ("id")
);
