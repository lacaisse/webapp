-- Three-tier address → profile resolver: this table is the persisted
-- fallback when an address doesn't match a local Card.account or
-- Merchant.citizenPayPlaceAccount. Populated from CitizenPay's batch
-- /v2/treasury/profiles endpoint. Keyed (fundId, address) because CP
-- credentials are per-fund and profile visibility may be too.

CREATE TABLE "AddressProfileCache" (
    "fundId"      TEXT    NOT NULL,
    "address"     TEXT    NOT NULL,
    "name"        TEXT,
    "username"    TEXT,
    "description" TEXT,
    "image"       TEXT,
    "imageMedium" TEXT,
    "imageSmall"  TEXT,
    "parent"      TEXT,
    "notFound"    BOOLEAN NOT NULL DEFAULT false,
    "fetchedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AddressProfileCache_pkey" PRIMARY KEY ("fundId", "address")
);

CREATE INDEX "AddressProfileCache_fundId_fetchedAt_idx"
  ON "AddressProfileCache"("fundId", "fetchedAt");

ALTER TABLE "AddressProfileCache"
  ADD CONSTRAINT "AddressProfileCache_fundId_fkey"
  FOREIGN KEY ("fundId") REFERENCES "Fund"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: ensure existing on-chain address columns are lowercased so the
-- resolver's join queries hit. CitizenPay normalises to lowercase on its
-- side, so legacy rows that happened to land checksum-cased would otherwise
-- be invisible to lookups going forward.
UPDATE "Card"
  SET "account" = LOWER("account")
  WHERE "account" IS NOT NULL AND "account" <> LOWER("account");

UPDATE "Merchant"
  SET "citizenPayPlaceAccount" = LOWER("citizenPayPlaceAccount")
  WHERE "citizenPayPlaceAccount" IS NOT NULL
    AND "citizenPayPlaceAccount" <> LOWER("citizenPayPlaceAccount");
