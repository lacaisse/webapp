-- Materialise the minter's Safe (salt 0) as the default token account for
-- every already-connected fund (those with a derived smart-account address).
-- New / reconnecting funds get theirs via consumeConnect. Empty name → the UI
-- renders a localised "main account" label. Idempotent via ON CONFLICT.

INSERT INTO "FundTokenAccount" ("id", "fundId", "name", "saltNonce", "address", "createdAt", "updatedAt")
SELECT
  gen_random_uuid()::text,
  "id",
  '',
  0,
  "tokenMinterSmartAccountAddress",
  now(),
  now()
FROM "Fund"
WHERE "tokenMinterSmartAccountAddress" IS NOT NULL
ON CONFLICT ("fundId", "saltNonce") DO NOTHING;
