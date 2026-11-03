-- Member login (plan "Bread card-holder voting", PR W-1): a card holder gets
-- a login at the fund that issued the card. One Better Auth User per person,
-- linked to one Member per fund through the existing Member.userId column
-- (its index, Member_userId_idx, exists since 20260510135503).

-- Per-fund opt-in. Off: no member pages, no User↔Member links, every card
-- of the fund stays public at Citizen Pay.
ALTER TABLE "Fund" ADD COLUMN "memberLoginEnabled" BOOLEAN NOT NULL DEFAULT false;

-- When Citizen Pay last accepted the card's holder state (PUT/DELETE
-- /v2/treasury/cards/{serial}/holder). Null = never synced, or the api route
-- was not deployed yet (404) — scripts/sync-card-holders.ts replays those.
ALTER TABLE "Card" ADD COLUMN "holderSyncedAt" TIMESTAMP(3);

-- A login sign-up's verification link is bound to the User it must verify
-- and (for an existing Member) link. Null on the classic /join and merchant
-- verifications.
ALTER TABLE "EmailVerification" ADD COLUMN "userId" UUID;
CREATE INDEX "EmailVerification_userId_idx" ON "EmailVerification"("userId");
ALTER TABLE "EmailVerification" ADD CONSTRAINT "EmailVerification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The OAuth provider's default refresh-token lifetime moves from 1 day to 30
-- days for the wallet client (services/auth/oauth-provider-config.ts). MCP
-- resources keep their one-day refresh tokens through the per-resource TTL,
-- which the provider only ever applies as a minimum against the default.
UPDATE "OauthResource"
SET "refreshTokenTtl" = 86400
WHERE "identifier" LIKE '%/api/mcp' AND "refreshTokenTtl" IS NULL;
