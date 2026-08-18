-- Embeddable website widgets. A fund can surface an account's balance/history
-- and its public merchant directory on its own website, inside an <iframe>
-- served from the fund's own host under /embed/*.
--
-- `Fund.embedAllowedDomains` is the allowlist of sites permitted to frame those
-- widgets. proxy.ts reads it on every fund request and emits
-- `Content-Security-Policy: frame-ancestors <list>`; the empty default means
-- `'none'`, so the widgets are off until an admin configures a domain. Stored
-- as a scalar array rather than a join table so the proxy's existing single-row
-- fund lookup still covers it. Entries are pre-validated CSP host-sources
-- (services/embed/schema.ts) — that validation is what makes joining them
-- straight into a header safe.
--
-- `FundTokenAccount.embedSlug` is the per-account public handle: NULL means not
-- embeddable, a value is an unguessable random token that is the only
-- credential on /embed/account/<slug>. Unique globally because the lookup is by
-- slug alone (then re-checked against the request host's fund); rotating mints
-- a new slug and thereby revokes every URL already published.

-- AlterTable
ALTER TABLE "Fund" ADD COLUMN     "embedAllowedDomains" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "FundTokenAccount" ADD COLUMN     "embedSlug" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "FundTokenAccount_embedSlug_key" ON "FundTokenAccount"("embedSlug");
